#!/usr/bin/env python3
"""Standalone NDJSON <-> MaaCore.dll bridge for the @local/arknights plugin.

This is the Python sidecar process spawned by ``lib/maa-session.js`` (see
``docs/contracts.md`` sections 1 and 2).  It is a long-running, single-instance
process:

    stdin  : one JSON request per line (``{"id":..., "op":..., "args":{...}}``)
    stdout : one JSON line per message -- the ``ready`` event, responses, and
             asynchronous MaaCore callback events (``{"event":"maa",...}``)
    stderr : free-form diagnostics, never parsed by the Node side

It is NOT imported as a module and it takes no command line arguments; run it
with::

    python -u lib/sidecar/maa_sidecar.py

Wire protocol: 2.0.0 (``docs/contracts.md`` §2).  Supported ops:

    init / connect / append / setParams / start / stop / running / connected /
    version / ping / screenshot / backHome / tasks / destroy

Design constraints honoured here (see task contract):
  * pure Python standard library only;
  * stdout carries protocol lines only, UTF-8 with ``\\n`` newlines, flushed
    after every line;
  * request lines are capped at 8 MiB (``E_PROTOCOL`` on overflow) so a broken
    Node peer can never make the sidecar allocate without bound;
  * the native MaaCore callback can fire on any thread, so it only enqueues
    ``(code, raw_json)`` tuples into a queue; a dedicated writer thread is the
    only consumer and assigns the monotonic ``seq``;
  * responses are written by the main thread; all stdout writes go through a
    single lock so events and responses can never interleave mid-line;
  * any request (including malformed JSON) produces either a valid response or
    a documented error code -- the sidecar never dies on bad input;
  * on stdin EOF the MAA instance is destroyed and the process exits 0.

MaaCore ABI notes (verified against the local MaaCore v6.21.0-beta.2 DLL):
  * ``AsstGetImage(handle, buff, buff_size)`` needs a **non-null** buffer and
    returns the PNG byte count, or a sentinel (0 / SIZE_MAX) on failure;
  * ``AsstGetTasksList(handle, buff, buff_size)`` fills an array of int32 task
    ids and returns the count, or SIZE_MAX when the buffer is too small;
  * ``AsstSetTaskParams(handle, task_id, params_json)`` only accepts int32 ids;
  * ``AsstSetStaticOption(1|2, value)`` selects CPU / GPU OCR and must be
    applied *before* ``AsstLoadResource``.
"""

import ctypes
import json
import os
import queue
import struct
import sys
import tempfile
import threading
import time
import traceback
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants (docs/contracts.md sections 2 and 6)
# ---------------------------------------------------------------------------

SIDECAR_VERSION = "2.0.0"
PROTOCOL_VERSION = "2.0.0"

MAX_LINE_BYTES = 8 * 1024 * 1024

TOUCH_MODES = ("minitouch", "maatouch", "adb", "macplaytools", "MumuExtras")
DEFAULT_TOUCH_MODE = "minitouch"

# MaaCore AsstSetInstanceOption keys (verified for v6.21).
OPTION_TOUCH_TYPE = 2
OPTION_DEPLOYMENT_WITH_PAUSE = 3
OPTION_CLIENT_TYPE = 6

# MaaCore AsstSetStaticOption keys (AsstTypes.h: Invalid=0, CpuOCR=1, GpuOCR=2).
STATIC_OPTION_CPU_OCR = 1
STATIC_OPTION_GPU_OCR = 2

DEFAULT_CONNECT_CONFIG = "General"
DEFAULT_CLIENT_TYPE = "Official"

# AsstSize failure sentinel: (AsstSize)-1 == SIZE_MAX.
NULL_SIZE = (1 << 64) - 1

# Screenshot buffer: 16 MiB covers 4K PNG frames; one 64 MiB retry for safety.
SCREENSHOT_BUFFER_BYTES = 16 * 1024 * 1024
SCREENSHOT_RETRY_BYTES = 64 * 1024 * 1024

# Task list buffer growth ladder (int32 entries).
TASK_LIST_SIZES = (64, 256, 1024, 4096)

# MaaCore callback message codes (docs/contracts.md section 6).
MAA_MESSAGE_NAMES = {
    0: "InternalError",
    1: "InitFailed",
    2: "ConnectionInfo",
    3: "AllTasksCompleted",
    4: "AsyncCallInfo",
    5: "Destroyed",
    10000: "TaskChainError",
    10001: "TaskChainStart",
    10002: "TaskChainCompleted",
    10003: "TaskChainExtraInfo",
    10004: "TaskChainStopped",
    20000: "SubTaskError",
    20001: "SubTaskStart",
    20002: "SubTaskCompleted",
    20003: "SubTaskExtraInfo",
    20004: "SubTaskStopped",
    30000: "ReportRequest",
}

# ---------------------------------------------------------------------------
# stdout writer: protocol lines only, serialised by one lock
# ---------------------------------------------------------------------------

# AsstCreateEx callback signature: void (*)(int msg, const char* details_json, void* custom_arg)
_CALLBACK_TYPE = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p)

_WRITE_LOCK = threading.Lock()
_EVENT_QUEUE = queue.Queue()
_EVENT_SEQ = 0
_WRITER_STOP = object()
_WRITER_THREAD = None

# Set DSH_ARKNIGHTS_SIDECAR_DEBUG=1 to also log every maa event line to stderr.
_DEBUG = os.environ.get("DSH_ARKNIGHTS_SIDECAR_DEBUG") == "1"

# Monotonic-ish suffix for unique screenshot file names.
_SHOT_COUNTER = 0


class _StdoutClosed(Exception):
    """Raised when the Node side has gone away and stdout is no longer writable."""


class SidecarError(Exception):
    """A protocol error mapped to a documented ``code`` (docs/contracts.md section 11)."""

    def __init__(self, code, message, detail=None):
        super(SidecarError, self).__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def _log(message):
    """Diagnostics go to stderr only -- stdout is reserved for protocol lines."""
    try:
        sys.stderr.write("[maa_sidecar] %s\n" % (message,))
        sys.stderr.flush()
    except Exception:  # pragma: no cover - stderr itself broken
        pass


def _configure_stdio():
    # UTF-8 and explicit "\n" so the Node NDJSON reader never sees CRLF.
    try:
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    except Exception:
        pass
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


def _write_json_line(payload):
    """Write one JSON protocol line to stdout (thread safe, flushed)."""
    try:
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
    except (TypeError, ValueError) as exc:  # pragma: no cover - defensive only
        _log("cannot serialise protocol line: %s" % (exc,))
        return
    with _WRITE_LOCK:
        try:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        except (BrokenPipeError, OSError, ValueError) as exc:
            raise _StdoutClosed(str(exc))


def _utc_now_iso():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


def _detail_text(value):
    """Coerce an arbitrary error detail into a short JSON-safe string."""
    if value is None:
        return None
    if isinstance(value, str):
        return value[:2000]
    try:
        return json.dumps(value, ensure_ascii=False, default=str)[:2000]
    except Exception:
        return str(value)[:2000]


def _error_response(request_id, exc):
    error = {"code": exc.code, "message": exc.message}
    detail = _detail_text(exc.detail)
    if detail:
        error["detail"] = detail
    return {"id": request_id, "ok": False, "error": error}


# ---------------------------------------------------------------------------
# Async MaaCore events: native callback -> queue -> dedicated writer thread
# ---------------------------------------------------------------------------

def _event_callback(code, details_json, _custom_arg):
    """Runs on a MaaCore native thread. Must never raise and must never write."""
    try:
        raw = details_json if details_json is not None else b""
        if not isinstance(raw, bytes):
            raw = bytes(raw)
        _EVENT_QUEUE.put((int(code), raw))
    except Exception:  # pragma: no cover - never propagate into native code
        _log("failed to enqueue maa callback event")


def _make_callback():
    return _CALLBACK_TYPE(_event_callback)


def _event_writer_loop():
    global _EVENT_SEQ
    while True:
        try:
            item = _EVENT_QUEUE.get()
        except Exception:  # pragma: no cover
            return
        if item is _WRITER_STOP:
            return
        code, raw = item
        try:
            text = raw.decode("utf-8", errors="replace")
            details = {}
            parse_failed = False
            if text.strip():
                try:
                    details = json.loads(text)
                except (json.JSONDecodeError, ValueError):
                    details = {}
                    parse_failed = True
            _EVENT_SEQ += 1
            event = {
                "event": "maa",
                "seq": _EVENT_SEQ,
                "code": code,
                "name": MAA_MESSAGE_NAMES.get(code, "Unknown"),
                "details": details,
                "ts": _utc_now_iso(),
            }
            if parse_failed:
                event["detailsRaw"] = text
            _write_json_line(event)
            if _DEBUG:
                _log("event seq=%d code=%d name=%s" % (_EVENT_SEQ, code, event["name"]))
        except _StdoutClosed:
            return
        except Exception:  # pragma: no cover - keep the writer alive
            _log("event writer failure: %s" % (traceback.format_exc(),))


def _start_event_writer():
    global _WRITER_THREAD
    _WRITER_THREAD = threading.Thread(target=_event_writer_loop, name="maa-event-writer", daemon=True)
    _WRITER_THREAD.start()


def _stop_event_writer(timeout=2.0):
    global _WRITER_THREAD
    thread = _WRITER_THREAD
    if thread is None:
        return
    _WRITER_THREAD = None
    try:
        _EVENT_QUEUE.put(_WRITER_STOP)
        thread.join(timeout)
    except Exception:  # pragma: no cover
        pass


# ---------------------------------------------------------------------------
# Small argument helpers
# ---------------------------------------------------------------------------

def _as_int(value, name, minimum=None):
    """Coerce a JSON number to int (bool is rejected); raises E_BAD_ARGS."""
    if isinstance(value, bool):
        raise SidecarError("E_BAD_ARGS", "参数 %s 必须是整数" % (name,), value)
    if isinstance(value, int):
        parsed = value
    elif isinstance(value, float) and value.is_integer():
        parsed = int(value)
    elif isinstance(value, str):
        try:
            parsed = int(value.strip())
        except ValueError:
            raise SidecarError("E_BAD_ARGS", "参数 %s 必须是整数" % (name,), value)
    else:
        raise SidecarError("E_BAD_ARGS", "参数 %s 必须是整数" % (name,), value)
    if minimum is not None and parsed < minimum:
        raise SidecarError("E_BAD_ARGS", "参数 %s 必须 >= %d" % (name, minimum), parsed)
    return parsed


def _default_user_dir():
    base = os.environ.get("TEMP") or os.environ.get("TMP") or os.getcwd()
    return os.path.join(base, "dsh-arknights-maa-user")


def _required_str(args, name):
    value = args.get(name)
    if not isinstance(value, str) or not value.strip():
        raise SidecarError("E_BAD_ARGS", "缺少必填参数 %s" % (name,), value)
    return value


def _optional_str(args, name, default):
    value = args.get(name)
    if value is None:
        return default
    if not isinstance(value, str) or not value.strip():
        raise SidecarError("E_BAD_ARGS", "参数 %s 必须是非空字符串" % (name,), value)
    return value


def _json_params(args, name="params"):
    """Normalise a task params object into compact JSON text."""
    params = args.get(name)
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise SidecarError("E_BAD_ARGS", "参数 %s 必须是 JSON 对象" % (name,), type(params).__name__)
    try:
        return json.dumps(params, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError) as exc:
        raise SidecarError("E_BAD_ARGS", "参数 %s 无法序列化" % (name,), str(exc))


def _png_dimensions(data):
    """Return ``(width, height)`` from a PNG byte string, or None when invalid."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    width, height = struct.unpack(">II", data[16:24])
    return int(width), int(height)


# ---------------------------------------------------------------------------
# MaaCore wrapper
# ---------------------------------------------------------------------------

class MaaCore(object):
    """Owns the MaaCore.dll handle, the optional instance and all instance options."""

    def __init__(self):
        self._dll = None
        self._dll_dir = None  # keep the os.add_dll_directory handle alive
        self._maa_path = None
        self._instance = None
        self._inited = False
        self._core_version = None
        self._resource_loaded = False
        self._user_dir = None
        self._touch_mode = DEFAULT_TOUCH_MODE
        self._deployment_with_pause = False
        self._gpu_ocr = None
        self._callback_ref = None  # keep the ctypes callback alive while MAA holds it
        # Optional exports (checked with hasattr on the loaded WinDLL).
        self._has_connected = False
        self._has_set_task_params = False
        self._has_back_to_home = False
        self._has_tasks_list = False
        self._has_get_image = False
        self._has_static_option = False

    # -- protocol op dispatch ------------------------------------------------

    def handle_request(self, request):
        op = request.get("op")
        if not isinstance(op, str) or not op.strip():
            raise SidecarError("E_BAD_OP", "请求缺少 op 字段", op)
        args = request.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            raise SidecarError("E_BAD_ARGS", "args 必须是 JSON 对象", type(args).__name__)
        if op == "init":
            return self.init(args)
        if op == "ping":
            return self.ping(args)
        if op == "version":
            return self.version(args)
        if op == "connect":
            return self.connect(args)
        if op == "append":
            return self.append(args)
        if op == "setParams":
            return self.set_params(args)
        if op == "start":
            return self.start(args)
        if op == "stop":
            return self.stop(args)
        if op == "running":
            return self.running(args)
        if op == "connected":
            return self.connected(args)
        if op == "backHome":
            return self.back_home(args)
        if op == "screenshot":
            return self.screenshot(args)
        if op == "tasks":
            return self.tasks(args)
        if op == "destroy":
            return self.destroy(args)
        raise SidecarError("E_BAD_OP", "未知 op: %s" % (op,), op)

    # -- state helpers -------------------------------------------------------

    def _require_inited(self):
        if not self._inited or not self._instance:
            raise SidecarError("E_NOT_INIT", "sidecar 尚未 init")

    def _instance_handle(self):
        self._require_inited()
        return self._instance

    def _init_result(self):
        return {
            "coreVersion": self._core_version,
            "resourceLoaded": bool(self._resource_loaded),
            "protocolVersion": PROTOCOL_VERSION,
            "sidecarVersion": SIDECAR_VERSION,
            "maaPath": self._maa_path,
            "userDir": self._user_dir,
            "touchMode": self._touch_mode,
            "deploymentWithPause": bool(self._deployment_with_pause),
            "gpuOcr": self._gpu_ocr,
        }

    def _read_version(self):
        if self._dll is None:
            return None
        try:
            raw = self._dll.AsstGetVersion()
        except Exception as exc:  # pragma: no cover - defensive
            _log("AsstGetVersion failed: %s" % (exc,))
            return None
        if not raw:
            return None
        if isinstance(raw, bytes):
            return raw.decode("utf-8", errors="replace")
        return str(raw)

    # -- DLL loading ---------------------------------------------------------

    def _load_dll(self, maa_path):
        if self._dll is not None:
            if self._maa_path and self._maa_path.lower() != maa_path.lower():
                _log(
                    "MaaCore.dll already loaded from %s; reusing it for %s"
                    % (self._maa_path, maa_path)
                )
            return self._dll
        if not hasattr(ctypes, "WinDLL"):  # pragma: no cover - plugin is Windows only
            raise SidecarError("E_MAA_LOAD", "当前平台不支持 ctypes.WinDLL", sys.platform)

        # The install root must be on PATH *before* the DLL is mapped so its
        # sibling dependencies (MaaUtils.dll, libloader.dll, ...) resolve.
        os.environ["PATH"] = maa_path + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            try:
                self._dll_dir = os.add_dll_directory(maa_path)
            except OSError as exc:  # pragma: no cover - PATH fallback still applies
                _log("os.add_dll_directory failed for %s: %s" % (maa_path, exc))

        dll_path = os.path.join(maa_path, "MaaCore.dll")
        try:
            dll = ctypes.WinDLL(dll_path)
        except OSError as exc:
            raise SidecarError("E_MAA_LOAD", "MaaCore.dll 加载失败", str(exc))
        try:
            self._bind(dll)
        except AttributeError as exc:
            raise SidecarError("E_MAA_LOAD", "MaaCore.dll 缺少所需导出符号", str(exc))
        self._dll = dll
        self._maa_path = maa_path
        _log("loaded MaaCore.dll from %s" % (dll_path,))
        return dll

    def _bind(self, dll):
        """Bind required exports strictly and optional ones best-effort."""
        dll.AsstSetUserDir.restype = ctypes.c_bool
        dll.AsstSetUserDir.argtypes = [ctypes.c_char_p]
        dll.AsstLoadResource.restype = ctypes.c_bool
        dll.AsstLoadResource.argtypes = [ctypes.c_char_p]
        dll.AsstCreate.restype = ctypes.c_void_p
        dll.AsstCreate.argtypes = []
        dll.AsstCreateEx.restype = ctypes.c_void_p
        dll.AsstCreateEx.argtypes = [_CALLBACK_TYPE, ctypes.c_void_p]
        dll.AsstDestroy.restype = None
        dll.AsstDestroy.argtypes = [ctypes.c_void_p]
        dll.AsstSetInstanceOption.restype = ctypes.c_bool
        dll.AsstSetInstanceOption.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]
        dll.AsstConnect.restype = ctypes.c_bool
        dll.AsstConnect.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p]
        dll.AsstAppendTask.restype = ctypes.c_int32
        dll.AsstAppendTask.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
        dll.AsstStart.restype = ctypes.c_bool
        dll.AsstStart.argtypes = [ctypes.c_void_p]
        dll.AsstStop.restype = ctypes.c_bool
        dll.AsstStop.argtypes = [ctypes.c_void_p]
        dll.AsstRunning.restype = ctypes.c_bool
        dll.AsstRunning.argtypes = [ctypes.c_void_p]
        dll.AsstGetVersion.restype = ctypes.c_char_p
        dll.AsstGetVersion.argtypes = []

        # Optional exports: probe with hasattr so old/new DLLs both work.
        if hasattr(dll, "AsstConnected"):
            dll.AsstConnected.restype = ctypes.c_bool
            dll.AsstConnected.argtypes = [ctypes.c_void_p]
            self._has_connected = True
        if hasattr(dll, "AsstSetTaskParams"):
            dll.AsstSetTaskParams.restype = ctypes.c_bool
            dll.AsstSetTaskParams.argtypes = [ctypes.c_void_p, ctypes.c_int32, ctypes.c_char_p]
            self._has_set_task_params = True
        if hasattr(dll, "AsstBackToHome"):
            dll.AsstBackToHome.restype = ctypes.c_bool
            dll.AsstBackToHome.argtypes = [ctypes.c_void_p]
            self._has_back_to_home = True
        if hasattr(dll, "AsstGetTasksList"):
            dll.AsstGetTasksList.restype = ctypes.c_size_t
            dll.AsstGetTasksList.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_int32),
                ctypes.c_size_t,
            ]
            self._has_tasks_list = True
        if hasattr(dll, "AsstGetImage"):
            dll.AsstGetImage.restype = ctypes.c_size_t
            dll.AsstGetImage.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
            self._has_get_image = True
        if hasattr(dll, "AsstSetStaticOption"):
            dll.AsstSetStaticOption.restype = ctypes.c_bool
            dll.AsstSetStaticOption.argtypes = [ctypes.c_int, ctypes.c_char_p]
            self._has_static_option = True

    def _apply_gpu_ocr(self, raw_value):
        """Apply the OCR acceleration static option *before* AsstLoadResource.

        Contract: ``gpuOcr`` is optional and best-effort -- a failure here must
        never block init (the sidecar just records it in the init result).
        """
        value = "" if raw_value is None else str(raw_value).strip()
        if value == "" or value.lower() == "auto":
            self._gpu_ocr = {"value": None, "applied": False, "detail": "auto（不干预）"}
            return
        if not self._has_static_option:
            self._gpu_ocr = {"value": value, "applied": False, "detail": "MaaCore 没有 AsstSetStaticOption"}
            _log("AsstSetStaticOption unavailable; gpuOcr=%s ignored" % (value,))
            return
        lowered = value.lower()
        cpu_mode = lowered in ("cpu", "off", "false", "disable", "disabled")
        # StaticOptionKey::CpuOCR == 1 (value not parsed); GpuOCR == 2 (device index / luid).
        mode = "cpu" if cpu_mode else "gpu"
        try:
            if cpu_mode:
                ok = bool(self._dll.AsstSetStaticOption(STATIC_OPTION_CPU_OCR, b"1"))
            else:
                ok = bool(self._dll.AsstSetStaticOption(STATIC_OPTION_GPU_OCR, value.encode("utf-8")))
        except Exception as exc:  # pragma: no cover - defensive
            self._gpu_ocr = {"value": value, "applied": False, "detail": str(exc)}
            _log("AsstSetStaticOption(%s) failed: %s" % (mode, exc))
            return
        self._gpu_ocr = {
            "value": value,
            "applied": ok,
            "detail": "cpu OCR" if mode == "cpu" else ("gpu OCR 已启用" if ok else "MaaCore 拒绝该 GPU 选择器"),
        }
        if not ok:
            _log("AsstSetStaticOption(%s, %s) returned false" % (mode, value))

    # -- ops -----------------------------------------------------------------

    def init(self, args):
        # Idempotent per docs/contracts.md §2.4: already inited -> current state.
        if self._inited and self._instance:
            return self._init_result()

        maa_path = os.path.abspath(_required_str(args, "maaPath"))
        raw_user_dir = args.get("userDir")
        if raw_user_dir is None or raw_user_dir == "":
            user_dir = os.path.abspath(_default_user_dir())
        elif isinstance(raw_user_dir, str):
            user_dir = os.path.abspath(raw_user_dir)
        else:
            raise SidecarError("E_BAD_ARGS", "参数 userDir 必须是字符串", type(raw_user_dir).__name__)
        touch_mode = args.get("touchMode", DEFAULT_TOUCH_MODE)
        if touch_mode is None:
            touch_mode = DEFAULT_TOUCH_MODE
        if not isinstance(touch_mode, str) or not touch_mode.strip():
            raise SidecarError("E_BAD_ARGS", "参数 touchMode 必须是非空字符串", touch_mode)
        deployment_with_pause = bool(args.get("deploymentWithPause", False))

        if not os.path.isdir(maa_path):
            raise SidecarError("E_MAA_NOT_FOUND", "MAA 安装目录不存在", maa_path)
        dll_path = os.path.join(maa_path, "MaaCore.dll")
        if not os.path.isfile(dll_path):
            raise SidecarError("E_MAA_NOT_FOUND", "未找到 MaaCore.dll", dll_path)

        try:
            os.makedirs(user_dir, exist_ok=True)
        except OSError as exc:
            raise SidecarError("E_MAA_LOAD", "无法创建 userDir", "%s: %s" % (user_dir, exc))

        dll = self._load_dll(maa_path)

        # Static options must be applied before the resource bundle is loaded.
        self._apply_gpu_ocr(args.get("gpuOcr"))

        # AsstSetUserDir's directory must already exist (contracts.md §2.4).
        if not dll.AsstSetUserDir(user_dir.encode("utf-8")):
            raise SidecarError("E_MAA_LOAD", "AsstSetUserDir 失败", user_dir)
        # AsstLoadResource takes the *install root* containing resource/, not resource/.
        if not dll.AsstLoadResource(maa_path.encode("utf-8")):
            raise SidecarError(
                "E_MAA_LOAD",
                "AsstLoadResource 失败（必须传包含 resource/ 的安装根目录）",
                maa_path,
            )

        callback = _make_callback()
        handle = None
        try:
            handle = dll.AsstCreateEx(callback, None)
            if not handle:
                raise SidecarError("E_MAA_LOAD", "AsstCreateEx 返回空句柄")
            if not dll.AsstSetInstanceOption(handle, OPTION_TOUCH_TYPE, touch_mode.encode("utf-8")):
                _log("warning: AsstSetInstanceOption(touch_type=%s) returned false" % (touch_mode,))
            pause_value = b"1" if deployment_with_pause else b"0"
            if not dll.AsstSetInstanceOption(handle, OPTION_DEPLOYMENT_WITH_PAUSE, pause_value):
                _log("warning: AsstSetInstanceOption(deployment_with_pause=%s) returned false" % (pause_value,))
        except Exception:
            if handle:
                try:
                    dll.AsstDestroy(handle)
                except Exception:  # pragma: no cover - best effort
                    pass
            raise

        self._callback_ref = callback
        self._instance = handle
        self._inited = True
        self._maa_path = maa_path
        self._user_dir = user_dir
        self._touch_mode = touch_mode
        self._deployment_with_pause = deployment_with_pause
        self._resource_loaded = True
        self._core_version = self._read_version()
        _log(
            "init ok maaPath=%s userDir=%s coreVersion=%s touchMode=%s deploymentWithPause=%s"
            % (maa_path, user_dir, self._core_version, touch_mode, deployment_with_pause)
        )
        return self._init_result()

    def ping(self, _args):
        return {"pong": True, "inited": bool(self._inited)}

    def version(self, _args):
        self._require_inited()
        core_version = self._read_version()
        if not core_version:
            raise SidecarError("E_MAA_LOAD", "AsstGetVersion 返回空版本号")
        return {"coreVersion": core_version, "protocolVersion": PROTOCOL_VERSION}

    def connect(self, args):
        handle = self._instance_handle()
        # connect is blocking (10s+) and must not run under the stdout lock.
        adb_path = _required_str(args, "adbPath")
        address = _required_str(args, "address")
        config = _optional_str(args, "config", DEFAULT_CONNECT_CONFIG)
        client_type = _optional_str(args, "clientType", DEFAULT_CLIENT_TYPE)
        dll = self._dll
        try:
            dll.AsstSetInstanceOption(handle, OPTION_CLIENT_TYPE, client_type.encode("utf-8"))
        except Exception as exc:  # pragma: no cover - defensive
            _log("AsstSetInstanceOption(client_type=%s) failed: %s" % (client_type, exc))
        try:
            connected = bool(
                dll.AsstConnect(handle, adb_path.encode("utf-8"), address.encode("utf-8"), config.encode("utf-8"))
            )
        except Exception as exc:
            raise SidecarError("E_CONNECT", "AsstConnect 调用异常", str(exc))
        if not connected:
            raise SidecarError(
                "E_CONNECT",
                "连接模拟器失败",
                "adbPath=%s address=%s config=%s clientType=%s" % (adb_path, address, config, client_type),
            )
        return {"connected": True}

    def append(self, args):
        handle = self._instance_handle()
        task_type = args.get("type")
        if not isinstance(task_type, str) or not task_type.strip():
            raise SidecarError("E_TASK_TYPE", "任务类型非法", task_type)
        params_json = _json_params(args, "params")
        try:
            task_id = int(self._dll.AsstAppendTask(handle, task_type.encode("utf-8"), params_json.encode("utf-8")))
        except Exception as exc:  # pragma: no cover - defensive
            raise SidecarError("E_TASK_TYPE", "AsstAppendTask 调用异常", str(exc))
        if task_id <= 0:
            raise SidecarError(
                "E_TASK_TYPE",
                "MAA 不接受该任务类型或参数",
                "type=%s ret=%d params=%s" % (task_type, task_id, params_json),
            )
        return {"taskId": task_id}

    def set_params(self, args):
        handle = self._instance_handle()
        if not self._has_set_task_params:
            raise SidecarError("E_NOT_SUPPORTED", "MaaCore 没有 AsstSetTaskParams", "setParams 不可用")
        task_id = _as_int(args.get("taskId"), "taskId", minimum=1)
        params_json = _json_params(args, "params")
        try:
            ok = bool(self._dll.AsstSetTaskParams(handle, task_id, params_json.encode("utf-8")))
        except Exception as exc:  # pragma: no cover - defensive
            raise SidecarError("E_TASK_REJECTED", "AsstSetTaskParams 调用异常", str(exc))
        if not ok:
            raise SidecarError(
                "E_TASK_REJECTED",
                "MAA 拒绝了任务参数更新",
                "taskId=%d params=%s" % (task_id, params_json),
            )
        return {"ok": True, "taskId": task_id}

    def start(self, _args):
        handle = self._instance_handle()
        try:
            started = bool(self._dll.AsstStart(handle))
        except Exception as exc:  # pragma: no cover - defensive
            raise SidecarError("E_CONNECT", "AsstStart 调用异常", str(exc))
        if not started:
            raise SidecarError("E_CONNECT", "AsstStart 失败（通常表示未连接模拟器）")
        return {"running": True}

    def stop(self, _args):
        handle = self._instance_handle()
        try:
            self._dll.AsstStop(handle)
        except Exception as exc:  # pragma: no cover - defensive
            _log("AsstStop failed: %s" % (exc,))
        # Contract: {running:false}. Stop is idempotent; a false return only means
        # "nothing was running", which is not an error for the caller.
        return {"running": False}

    def running(self, _args):
        handle = self._instance_handle()
        return {"running": bool(self._dll.AsstRunning(handle))}

    def connected(self, _args):
        handle = self._instance_handle()
        # Contract §2.4: use AsstConnected when the DLL exports it,
        # otherwise fall back to {connected:null}.
        if self._has_connected:
            return {"connected": bool(self._dll.AsstConnected(handle))}
        return {"connected": None}

    def back_home(self, _args):
        handle = self._instance_handle()
        if not self._has_back_to_home:
            raise SidecarError("E_NOT_SUPPORTED", "MaaCore 没有 AsstBackToHome", "backHome 不可用")
        try:
            ok = bool(self._dll.AsstBackToHome(handle))
        except Exception as exc:  # pragma: no cover - defensive
            raise SidecarError("E_TASK_REJECTED", "AsstBackToHome 调用异常", str(exc))
        if not ok:
            raise SidecarError(
                "E_TASK_REJECTED",
                "AsstBackToHome 返回 false（通常表示尚未连接模拟器）",
            )
        return {"ok": True}

    def tasks(self, _args):
        handle = self._instance_handle()
        # Optional op: any failure degrades to an empty list (never blocks a run).
        if not self._has_tasks_list:
            return {"taskIds": [], "supported": False, "detail": "MaaCore 没有 AsstGetTasksList"}
        for size in TASK_LIST_SIZES:
            buffer = (ctypes.c_int32 * size)()
            try:
                count = int(self._dll.AsstGetTasksList(handle, buffer, size))
            except Exception as exc:  # pragma: no cover - defensive
                return {"taskIds": [], "supported": False, "detail": str(exc)}
            if count == NULL_SIZE or count > size:
                continue
            return {"taskIds": [int(buffer[index]) for index in range(count)], "supported": True}
        return {"taskIds": [], "supported": False, "detail": "任务列表超过缓冲上限"}

    def screenshot(self, args):
        handle = self._instance_handle()
        fmt = args.get("format", "png")
        if fmt is None:
            fmt = "png"
        if not isinstance(fmt, str) or fmt.strip().lower() not in ("png",):
            raise SidecarError("E_NOT_SUPPORTED", "只支持 format=\"png\"", fmt)
        if not self._has_get_image:
            raise SidecarError("E_NOT_SUPPORTED", "MaaCore 没有 AsstGetImage", "screenshot 不可用")

        data = b""
        last_detail = ""
        for buffer_size in (SCREENSHOT_BUFFER_BYTES, SCREENSHOT_RETRY_BYTES):
            buffer = ctypes.create_string_buffer(buffer_size)
            try:
                got = int(self._dll.AsstGetImage(handle, buffer, buffer_size))
            except Exception as exc:  # pragma: no cover - defensive
                raise SidecarError("E_NOT_SUPPORTED", "AsstGetImage 调用异常", str(exc))
            if got in (0, NULL_SIZE) or got > buffer_size:
                last_detail = "AsstGetImage 返回 %s（buffer=%d）" % (got, buffer_size)
                continue
            data = buffer.raw[:got]
            break
        if not data:
            raise SidecarError(
                "E_NOT_SUPPORTED",
                "截图不可用（AsstGetImage 失败）",
                last_detail or "未连接模拟器或控制单元不支持截图",
            )
        dimensions = _png_dimensions(data)
        if dimensions is None:
            raise SidecarError("E_NOT_SUPPORTED", "AsstGetImage 返回的不是 PNG 数据", data[:16])
        width, height = dimensions

        directory = args.get("dir")
        if directory is None or directory == "":
            directory = os.path.join(tempfile.gettempdir(), "dsh-arknights-shots")
        elif not isinstance(directory, str):
            raise SidecarError("E_BAD_ARGS", "参数 dir 必须是字符串", type(directory).__name__)
        directory = os.path.abspath(directory)
        prefix = args.get("prefix")
        if prefix is None or prefix == "":
            prefix = "shot"
        elif not isinstance(prefix, str):
            raise SidecarError("E_BAD_ARGS", "参数 prefix 必须是字符串", type(prefix).__name__)
        prefix = "".join(ch for ch in prefix if ch.isalnum() or ch in ("-", "_")) or "shot"

        global _SHOT_COUNTER
        _SHOT_COUNTER += 1
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        filename = "%s-%s-%03d-%d.png" % (prefix, stamp, _SHOT_COUNTER % 1000, os.getpid())
        target = os.path.join(directory, filename)
        try:
            os.makedirs(directory, exist_ok=True)
            with open(target, "wb") as handle_out:
                handle_out.write(data)
        except OSError as exc:
            raise SidecarError("E_BAD_ARGS", "截图写入失败", "%s: %s" % (target, exc))
        return {"path": target, "width": width, "height": height, "bytes": len(data)}

    def destroy(self, _args):
        self._require_inited()
        handle = self._instance
        self._instance = None
        self._inited = False
        try:
            self._dll.AsstDestroy(handle)
        except Exception as exc:  # pragma: no cover - defensive
            _log("AsstDestroy failed: %s" % (exc,))
        _log("instance destroyed")
        return {"destroyed": True}

    def destroy_quietly(self):
        """Best-effort destroy used on stdin EOF / fatal shutdown."""
        handle = self._instance
        if not handle:
            self._inited = False
            return
        self._instance = None
        self._inited = False
        try:
            self._dll.AsstDestroy(handle)
        except Exception as exc:  # pragma: no cover - best effort
            _log("AsstDestroy during shutdown failed: %s" % (exc,))


# ---------------------------------------------------------------------------
# stdin request loop
# ---------------------------------------------------------------------------

def _emit_ready():
    python_version = "%d.%d.%d" % (
        sys.version_info[0],
        sys.version_info[1],
        sys.version_info[2],
    )
    _write_json_line(
        {
            "event": "ready",
            "sidecarVersion": SIDECAR_VERSION,
            "protocolVersion": PROTOCOL_VERSION,
            "python": python_version,
            "platform": sys.platform,
        }
    )


def _handle_line(core, line):
    try:
        request = json.loads(line)
    except (json.JSONDecodeError, ValueError) as exc:
        _log("malformed request JSON: %s" % (exc,))
        _write_json_line(
            {
                "id": None,
                "ok": False,
                "error": {
                    "code": "E_PROTOCOL",
                    "message": "请求不是合法 JSON",
                    "detail": str(exc)[:500],
                },
            }
        )
        return
    if not isinstance(request, dict):
        _log("request is not a JSON object")
        _write_json_line(
            {
                "id": None,
                "ok": False,
                "error": {"code": "E_PROTOCOL", "message": "请求必须是 JSON 对象"},
            }
        )
        return

    request_id = request.get("id")
    try:
        result = core.handle_request(request)
        response = {"id": request_id, "ok": True, "result": result}
    except SidecarError as exc:
        _log("op failed: op=%s code=%s message=%s" % (request.get("op"), exc.code, exc.message))
        response = _error_response(request_id, exc)
    except Exception:
        _log("unexpected handler error: %s" % (traceback.format_exc(),))
        response = _error_response(
            request_id,
            SidecarError("E_PROTOCOL", "sidecar 内部错误", traceback.format_exc()),
        )
    _write_json_line(response)


def _read_request_line(stream):
    """Read one bounded line from stdin.

    Returns the decoded text (without the trailing newline) or ``None`` on EOF.
    Raises ``SidecarError('E_PROTOCOL')`` when the line exceeds 8 MiB; the
    oversized remainder is drained so the next request still parses.
    """
    try:
        raw = stream.readline(MAX_LINE_BYTES + 2)
    except OSError as exc:  # pragma: no cover - stdin torn down
        _log("stdin read failed: %s" % (exc,))
        return None
    if not raw:
        return None
    if len(raw) > MAX_LINE_BYTES and not raw.endswith(b"\n"):
        # Drain the rest of the oversized line.
        while True:
            try:
                chunk = stream.readline(65536)
            except OSError:  # pragma: no cover
                break
            if not chunk or chunk.endswith(b"\n"):
                break
        raise SidecarError("E_PROTOCOL", "请求行超过 %d 字节上限" % (MAX_LINE_BYTES,))
    if isinstance(raw, bytes):
        text = raw.decode("utf-8", errors="replace").strip()
    else:
        text = raw.strip()
    return text


def _serve(core):
    stdin = sys.stdin
    if stdin is None:  # pragma: no cover - spawned with a pipe in practice
        return
    stream = stdin.buffer if hasattr(stdin, "buffer") else stdin
    while True:
        try:
            line = _read_request_line(stream)
        except SidecarError as exc:
            _log("overlong request line: %s" % (exc.message,))
            _write_json_line(
                {
                    "id": None,
                    "ok": False,
                    "error": {"code": exc.code, "message": exc.message},
                }
            )
            continue
        if line is None:
            _log("stdin EOF")
            return
        if line == "":
            continue
        _handle_line(core, line)


def main(_argv=None):
    _configure_stdio()
    if sys.stdout is None:  # pragma: no cover - pathological
        return 0
    try:
        _emit_ready()
    except _StdoutClosed as exc:
        _log("stdout closed before ready: %s" % (exc,))
        return 0

    _start_event_writer()
    core = MaaCore()
    exit_code = 0
    try:
        _serve(core)
    except KeyboardInterrupt:
        _log("interrupted")
    except _StdoutClosed as exc:
        _log("stdout closed: %s" % (exc,))
    except Exception:
        _log("fatal sidecar error: %s" % (traceback.format_exc(),))
        exit_code = 1
    finally:
        try:
            core.destroy_quietly()
        except Exception:  # pragma: no cover - never mask the real exit path
            _log("shutdown destroy failed: %s" % (traceback.format_exc(),))
        _stop_event_writer()
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
