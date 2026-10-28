/**
 * 环境缓存：把「MAA / Python / MuMu / adb 在哪、模拟器开没开」集中缓存一次。
 *
 * 侧车 init 与 runner 的前置检查都要用同一份探测结果，所以这里做唯一入口；
 * `fresh: true` 会重探（启动模拟器后必须重探）。
 *
 * @module @local/arknights/environment
 */

import { detectAll } from './detect.js';

/**
 * 造一个环境缓存。
 * @param {{ config: any, paths: { userDir: string }, logger?: any }} options - 选项。
 * @returns {object} 环境对象。
 */
export function createEnvironment(options) {
  const { config, paths, logger } = options;
  /** @type {Record<string, any> | null} */
  let detection = null;
  /** @type {Promise<Record<string, any>> | null} */
  let inflight = null;

  /**
   * 取探测结果。
   * @param {{ fresh?: boolean }} [input] - 是否重探。
   * @returns {Promise<Record<string, any>>} 探测结果。
   */
  const get = async (input = {}) => {
    const fresh = input.fresh === true;
    if (!fresh && detection !== null) return detection;
    if (!fresh && inflight !== null) return inflight;
    const task = (async () => {
      try {
        const value = await detectAll(config, { fresh });
        detection = value;
        return value;
      } finally {
        if (inflight === task) inflight = null;
      }
    })();
    inflight = task;
    return task;
  };

  /**
   * 侧车 `init` 的参数。
   * @returns {Promise<{ maaPath: string, userDir: string, touchMode: string, deploymentWithPause: boolean }>} 参数。
   */
  const initArgs = async () => {
    const detected = await get();
    if (detected.maaPath === '') {
      throw new Error('没有找到 MAA 的 MaaCore.dll（见 ark_status 的探测路径）。');
    }
    return {
      maaPath: detected.maaPath,
      userDir: paths.userDir,
      touchMode: config.touchMode,
      deploymentWithPause: config.deploymentWithPause,
    };
  };

  return {
    get,
    initArgs,
    /** 清缓存（模拟器状态变化后调用）。 */
    clear: () => {
      detection = null;
      inflight = null;
    },
    /** 只读缓存视图（状态路由用，绝不触发探测）。 */
    peek: () => detection,
  };
}
