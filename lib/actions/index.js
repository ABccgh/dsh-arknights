/**
 * 动作门面：把各动作模块组装成 `actions.fight/push/...`，并给 HTTP 提供 `start(payload)`。
 *
 * 每个动作模块导出 `createXAction(deps)`，返回 `async (params) => response`；
 * 工具直接调用 `actions.fight(args)`（默认等待完成），HTTP 走 `start()`（默认不等待）。
 *
 * @module @local/arknights/actions
 */

import { arkError } from '../errors.js';
import { createAwardAction } from './award.js';
import { createBoxAction } from './box.js';
import { createDailyAction } from './daily.js';
import { createFightAction } from './fight.js';
import { createInfrastAction } from './infrast.js';
import { createMallAction } from './mall.js';
import { createPushAction } from './push.js';
import { createRecruitAction } from './recruit.js';
import { createRogueAction } from './rogue.js';
import { createSolutionsAction } from './copilot.js';
import { createStopAction } from './stop.js';

/**
 * 造动作门面。
 * @param {Record<string, any>} deps - 依赖（见 lib/index.js）。
 * @returns {Record<string, any>} actions。
 */
export function createActions(deps) {
  /** @type {Record<string, Function>} */
  const actions = {
    fight: createFightAction(deps),
    push: createPushAction(deps),
    rogue: createRogueAction(deps),
    daily: createDailyAction(deps),
    recruit: createRecruitAction(deps),
    infrast: createInfrastAction(deps),
    mall: createMallAction(deps),
    award: createAwardAction(deps),
    box: createBoxAction(deps),
    solutions: createSolutionsAction(deps),
    stop: createStopAction(deps),
  };

  /**
   * HTTP 入口：按 `action` 分发；默认 `wait=false`（立即返回 runId）。
   * @param {Record<string, any>} payload - 请求体。
   * @returns {Promise<Record<string, any>>} 响应。
   */
  const start = async (payload) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw arkError('E_BAD_ARGS', '动作请求必须是对象。');
    }
    const kind = typeof payload.action === 'string' ? payload.action.trim() : '';
    if (kind === '') throw arkError('E_BAD_ARGS', '缺少 action。');
    const handler = actions[kind];
    if (typeof handler !== 'function') {
      throw arkError('E_ACTION_UNKNOWN', `未知动作「${kind}」。`, {
        hint: '可用：fight / push / rogue / daily / recruit / infrast / mall / award / box / stop。',
      });
    }
    const params = { ...payload };
    delete params.action;
    if (kind === 'stop') return handler(params);
    if (typeof params.wait !== 'boolean') params.wait = payload.wait === true;
    return handler(params);
  };

  return { ...actions, start };
}
