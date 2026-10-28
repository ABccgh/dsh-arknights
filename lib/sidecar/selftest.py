#!/usr/bin/env python3
"""Offline self-test for the local MaaCore.dll used by the @local/arknights plugin.

This tool proves that this machine can load MaaCore and drive it through the
ctypes C ABI *without* an emulator and *without* running any MAA task:

  1. the user dir can be created
  2. MaaCore.dll exists and can be loaded (install root prepended to PATH)
  3. AsstSetUserDir and AsstLoadResource succeed
  4. AsstGetVersion returns a non-empty version string (printed)
  5. AsstCreateEx returns a non-null instance handle
  6. AsstAppendTask("StartUp", ...) returns taskId > 0  (append only, never start)
  7. AsstAppendTask("Bogus", ...) returns 0             (invalid type is rejected)
  8. AsstDestroy does not raise

Run it with an explicit MAA path (or set ``DSH_ARKNIGHTS_MAA_PATH``):

    python lib/sidecar/selftest.py --maa-path D:\\MAA --user-dir %TEMP%\\maa-selftest
    python lib/sidecar/selftest.py --json

(``test/run-selftest.mjs`` auto-detects MAA and passes ``--maa-path`` for you.)

Output contract: stdout is always the human-readable PASS/FAIL lines (suppressed
with --json) followed by exactly one line of JSON summary.  Exit code is 0 only
if every check passed.

Note on StartUp params: on MAA v6.21 a bare ``{}`` params object is rejected by
AsstAppendTask (returns 0), so the check passes ``{"client_type": "Official"}``.
The instance is only *appended* to, then destroyed; nothing is ever started.
"""

import argparse
import ctypes
import json
import os
import sys
import tempfile
import time
import traceback

DEFAULT_MAA_PATH = os.environ.get("DSH_ARKNIGHTS_MAA_PATH", "")
DEFAULT_USER_DIR_NAME = "dsh-arknights-selftest"

# AsstCreateEx callback; this self-test only needs a live callback pointer.
CALLBACK_TYPE = ctypes.CFUNCTYPE(None, ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p)


def _default_user_dir():
    base = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    return os.path.join(base, DEFAULT_USER_DIR_NAME)


def _bind(dll):
    """Apply the documented C ABI prototypes (docs/contracts.md section 3)."""
    dll.AsstSetUserDir.restype = ctypes.c_bool
    dll.AsstSetUserDir.argtypes = [ctypes.c_char_p]
    dll.AsstLoadResource.restype = ctypes.c_bool
    dll.AsstLoadResource.argtypes = [ctypes.c_char_p]
    dll.AsstCreate.restype = ctypes.c_void_p
    dll.AsstCreate.argtypes = []
    dll.AsstCreateEx.restype = ctypes.c_void_p
    dll.AsstCreateEx.argtypes = [CALLBACK_TYPE, ctypes.c_void_p]
    dll.AsstDestroy.restype = None
    dll.AsstDestroy.argtypes = [ctypes.c_void_p]
    dll.AsstSetInstanceOption.restype = ctypes.c_bool
    dll.AsstSetInstanceOption.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_char_p]
    dll.AsstAppendTask.restype = ctypes.c_int
    dll.AsstAppendTask.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    dll.AsstGetVersion.restype = ctypes.c_char_p
    dll.AsstGetVersion.argtypes = []


class SelfTest(object):
    def __init__(self, maa_path, user_dir, quiet=False):
        self.maa_path = os.path.abspath(maa_path)
        self.user_dir = os.path.abspath(user_dir)
        self.quiet = quiet
        self.checks = []
        self.core_version = None
        self.dll = None
        self.instance = None
        self._callback_ref = None
        self._started_at = time.time()
        self._fatal = None

    # -- reporting -----------------------------------------------------------

    def record(self, name, ok, detail=None):
        entry = {"name": name, "ok": bool(ok)}
        if detail is not None:
            entry["detail"] = str(detail)[:1000]
        self.checks.append(entry)
        if not self.quiet:
            status = "PASS" if ok else "FAIL"
            suffix = "" if detail is None else ": %s" % (detail,)
            print("[%s] %s%s" % (status, name, suffix), flush=True)
        return bool(ok)

    def fail(self, name, exc, detail=None):
        detail = detail if detail is not None else str(exc)
        self.record(name, False, detail)
        self._fatal = name

    def summary(self):
        failed = [entry["name"] for entry in self.checks if not entry["ok"]]
        ok = bool(self.checks) and not failed
        return {
            "ok": ok,
            "checksTotal": len(self.checks),
            "checksPassed": len(self.checks) - len(failed),
            "checksFailed": failed,
            "coreVersion": self.core_version,
            "maaPath": self.maa_path,
            "userDir": self.user_dir,
            "python": "%d.%d.%d" % (sys.version_info[0], sys.version_info[1], sys.version_info[2]),
            "platform": sys.platform,
            "elapsedMs": int((time.time() - self._started_at) * 1000),
        }

    # -- checks --------------------------------------------------------------

    def run(self):
        # 1. user dir
        try:
            os.makedirs(self.user_dir, exist_ok=True)
            self.record("userDir", True, self.user_dir)
        except OSError as exc:
            self.fail("userDir", exc)
            return

        # 2. MaaCore.dll present
        dll_path = os.path.join(self.maa_path, "MaaCore.dll")
        if not os.path.isfile(dll_path):
            self.record("dllExists", False, dll_path)
            return
        self.record("dllExists", True, dll_path)

        # 3. load the DLL; the install root must be on PATH before WinDLL
        if not hasattr(ctypes, "WinDLL"):  # pragma: no cover - Windows only
            self.record("dllLoad", False, "ctypes.WinDLL unavailable on %s" % (sys.platform,))
            return
        os.environ["PATH"] = self.maa_path + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(self.maa_path)
            except OSError:
                pass
        try:
            self.dll = ctypes.WinDLL(dll_path)
            self.record("dllLoad", True, dll_path)
        except OSError as exc:
            self.record("dllLoad", False, str(exc))
            return

        try:
            _bind(self.dll)
        except AttributeError as exc:
            self.record("dllBind", False, "missing export: %s" % (exc,))
            return
        self.record("dllBind", True, "MaaCore C ABI prototypes applied")

        # 4. user dir + resource must be loaded before create
        try:
            ok = bool(self.dll.AsstSetUserDir(self.user_dir.encode("utf-8")))
        except Exception as exc:  # noqa: BLE001 - report any ctypes failure
            self.record("setUserDir", False, traceback.format_exc())
            return
        if not self.record("setUserDir", ok, self.user_dir):
            return

        try:
            ok = bool(self.dll.AsstLoadResource(self.maa_path.encode("utf-8")))
        except Exception:
            self.record("loadResource", False, traceback.format_exc())
            return
        if not self.record("loadResource", ok, self.maa_path):
            return

        # 5. core version
        try:
            raw = self.dll.AsstGetVersion()
            version = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw or "")
        except Exception:
            version = ""
        self.core_version = version or None
        if not self.record("coreVersion", bool(version), version):
            return

        # 6. create exactly one instance, with the async-event callback
        def _noop_callback(_code, _details, _arg):
            return None

        self._callback_ref = CALLBACK_TYPE(_noop_callback)
        try:
            self.instance = self.dll.AsstCreateEx(self._callback_ref, None)
        except Exception:
            self.record("create", False, traceback.format_exc())
            return
        if not self.record("create", bool(self.instance), "handle=%s" % (self.instance,)):
            return

        # instance options the sidecar always applies: touch_type=2, pause=3
        self.record(
            "instanceOptions",
            bool(self.dll.AsstSetInstanceOption(self.instance, 2, b"minitouch"))
            and bool(self.dll.AsstSetInstanceOption(self.instance, 3, b"0")),
            "touch_type=minitouch deployment_with_pause=0",
        )

        # 7. append StartUp (never start it) -- params must include client_type
        startup_params = json.dumps({"client_type": "Official"}, ensure_ascii=False)
        try:
            task_id = int(self.dll.AsstAppendTask(self.instance, b"StartUp", startup_params.encode("utf-8")))
        except Exception:
            task_id = -999
        self.record(
            "appendStartUp",
            task_id > 0,
            "taskId=%d params=%s" % (task_id, startup_params),
        )

        # 8. append an invalid task type: MAA must reject it with 0
        try:
            bogus_id = int(self.dll.AsstAppendTask(self.instance, b"Bogus", b"{}"))
        except Exception:
            bogus_id = -999
        self.record("appendBogus", bogus_id == 0, "ret=%d" % (bogus_id,))

        # 9. destroy
        handle = self.instance
        self.instance = None
        try:
            self.dll.AsstDestroy(handle)
            self.record("destroy", True)
        except Exception:
            self.record("destroy", False, traceback.format_exc())

    def cleanup(self):
        # Best-effort destroy when an earlier check aborted the flow.
        if self.instance:
            handle = self.instance
            self.instance = None
            try:
                self.dll.AsstDestroy(handle)
            except Exception:
                pass


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Offline self-test for MaaCore.dll (no emulator, no task execution).",
    )
    parser.add_argument(
        "--maa-path",
        default=DEFAULT_MAA_PATH,
        required=DEFAULT_MAA_PATH == "",
        help="MAA install root containing MaaCore.dll and resource/ "
             "(default: $DSH_ARKNIGHTS_MAA_PATH; test/run-selftest.mjs auto-detects it)",
    )
    parser.add_argument(
        "--user-dir",
        default=_default_user_dir(),
        help="MAA user directory, created if missing (default: %(default)s)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="suppress human-readable lines; print only the one-line JSON summary",
    )
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    tester = SelfTest(args.maa_path, args.user_dir, quiet=args.json)
    try:
        tester.run()
    except Exception:
        tester.fail("unexpected", traceback.format_exc())
    finally:
        tester.cleanup()
    summary = tester.summary()
    print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
