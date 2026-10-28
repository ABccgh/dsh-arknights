/**
 * 本地版 `defineTool`（与 dsh-input / dsh-steam 同源，按本插件改写注释）。
 *
 * **为什么不用 `@deepseek-ai/dsh-tools` 的 `defineTool`：** 本插件作为 `link:` 的 profile
 * bundle 安装，代码住在 `%USERPROFILE%\dsh-bundles\arknights`，不在 DSH 的安装作用域里；
 * bundle 里的 `@deepseek-ai/*` 导入不会被重定向，会以 `ERR_MODULE_NOT_FOUND` 让插件加载失败。
 *
 * 工具注册表真正需要的只有：`name` / `description` / `parameters`(JSON Schema) /
 * `output.schema` + `output.render` / `execute`。所以这里把「简写 spec」编译成 JSON Schema，
 * 并补上参数校验，插件因此零外部依赖（只 import `node:*` 与自己的模块）。
 *
 * @module @local/arknights/tool-kit
 */

/** DSH 工具注册表支持的 JSON Schema 标量类型。 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null']);

/**
 * 把一条简写参数 spec 编译成 JSON Schema 节点。
 * @param {{ type?: string, description?: string, enum?: unknown[], default?: unknown,
 *   items?: object, properties?: Record<string, object>, additionalProperties?: boolean }} node
 *   简写 spec。
 * @returns {Record<string, unknown>} JSON Schema 节点。
 */
export function specToJsonSchema(node) {
  if (node === null || typeof node !== 'object') throw new TypeError('参数 spec 必须是一个对象');
  const { type } = node;
  if (typeof type !== 'string') throw new TypeError(`参数 spec 缺少 type：${JSON.stringify(node)}`);

  /** @type {Record<string, unknown>} */
  const schema = { type };
  if (typeof node.description === 'string') schema.description = node.description;
  if (Array.isArray(node.enum)) schema.enum = [...node.enum];
  if (node.default !== undefined) schema.default = node.default;

  if (type === 'array') {
    if (node.items !== undefined) schema.items = specToJsonSchema(node.items);
  } else if (type === 'object') {
    const properties = {};
    const required = [];
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      properties[key] = specToJsonSchema(child);
      if (child.required === true) required.push(key);
    }
    schema.properties = properties;
    if (required.length > 0) schema.required = required;
    if (node.additionalProperties === false) schema.additionalProperties = false;
  } else if (!SCALAR_TYPES.has(type)) {
    throw new TypeError(`不支持的参数类型 ${JSON.stringify(type)}`);
  }
  return schema;
}

/**
 * 把「参数名 → spec」的映射编译成 object 根 JSON Schema。
 * @param {Record<string, object>} spec - 简写 spec 映射。
 * @returns {Record<string, unknown>} JSON Schema。
 */
export function parametersToJsonSchema(spec = {}) {
  const properties = {};
  const required = [];
  for (const [key, node] of Object.entries(spec)) {
    properties[key] = specToJsonSchema(node);
    if (node.required === true) required.push(key);
  }
  /** @type {Record<string, unknown>} */
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * 按 schema 把参数收成正确的标量类型，并检查必填项。
 *
 * 模型的参数不完全可信（`"5"` 和 `5` 都出现过），所以这里做一次最小归一：
 * 只处理能被无歧义转换的情况，其余留给 `execute` 自己报错。
 * @param {Record<string, any>} schema - `parametersToJsonSchema` 的产物。
 * @param {unknown} rawArgs - 注册表解析出来的原始参数。
 * @returns {Record<string, unknown>} 归一后的参数。
 * @throws {Error} 参数不是对象，或缺少必填项时。
 */
export function coerceArguments(schema, rawArgs) {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是一个对象。');

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    const value = /** @type {Record<string, unknown>} */ (args)[key];
    if (value === undefined || value === null) continue;
    out[key] = coerceScalar(/** @type {any} */ (node), value, key);
  }
  for (const key of /** @type {string[]} */ (schema.required ?? [])) {
    if (out[key] === undefined) throw new Error(`缺少必填参数 ${key}。`);
  }
  return out;
}

/**
 * 按一个 JSON Schema 节点归一单个值。
 * @param {{ type: string }} node - schema 节点。
 * @param {unknown} value - 原始值。
 * @param {string} key - 参数名（用于错误消息）。
 * @returns {unknown} 归一后的值。
 */
function coerceScalar(node, value, key) {
  switch (node.type) {
    case 'integer': {
      const parsed = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(String(value), 10);
      if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 必须是整数。`);
      return parsed;
    }
    case 'number': {
      const parsed = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(parsed)) throw new Error(`参数 ${key} 必须是数字。`);
      return parsed;
    }
    case 'string':
      return typeof value === 'string' ? value : String(value);
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error(`参数 ${key} 必须是布尔值。`);
    case 'array':
      if (!Array.isArray(value)) throw new Error(`参数 ${key} 必须是数组。`);
      return value;
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`参数 ${key} 必须是对象。`);
      return value;
    default:
      return value;
  }
}

/**
 * 定义并校验一个工具，返回注册表可以直接接收的 definition。
 *
 * 与 DSH 的 `defineTool` 形状一致，只是不依赖任何 DSH 包：
 * `{ name, description, parameters(JSON Schema), output: { schema, render }, execute, ... }`。
 * @param {{ name: string, description: string, parameters?: Record<string, object>,
 *   output: { schema: object, render: (args: any, value: any) => object[], presentationMeta?: Function },
 *   execute: (args: any, exec: any) => Promise<any>, isConcurrencySafe?: Function,
 *   presentCall?: Function, timeoutMs?: number }} options - 工具定义。
 * @returns {object} 可注册的定义。
 */
export function defineTool(options) {
  const { name, description, parameters = {}, output } = options;
  if (typeof name !== 'string' || name === '') throw new TypeError('工具必须有 name');
  if (name === 'run_code') throw new Error('run_code 是 PTC 模式保留的工具名');
  if (typeof description !== 'string' || description === '') throw new TypeError(`工具 ${name} 必须有 description`);
  if (output === null || typeof output !== 'object') throw new TypeError(`工具 ${name} 必须声明 output`);
  if (typeof output.render !== 'function') throw new TypeError(`工具 ${name} 的 output.render 必须是函数`);
  if (typeof options.execute !== 'function') throw new TypeError(`工具 ${name} 必须有 execute`);

  const schema = parametersToJsonSchema(parameters);
  const outputSchema = specToJsonSchema(output.schema);

  /** @type {Record<string, unknown>} */
  const definition = {
    name,
    description,
    parameters: schema,
    output: {
      schema: outputSchema,
      render: output.render,
      ...(typeof output.presentationMeta === 'function' ? { presentationMeta: output.presentationMeta } : {}),
    },
    async execute(rawArgs, exec) {
      return options.execute(coerceArguments(schema, rawArgs), exec);
    },
  };
  if (typeof options.isConcurrencySafe === 'function') definition.isConcurrencySafe = options.isConcurrencySafe;
  if (typeof options.presentCall === 'function') definition.presentCall = options.presentCall;
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs;
  return definition;
}

/**
 * 所有 `ark_*` 工具统一的输出形状：一段给模型读的文本。
 * @type {{ schema: object, render: (args: unknown, value: { text?: unknown }) => object[] }}
 */
export const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: '给模型阅读的文本结果' },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

/**
 * 包一个文本结果。
 * @param {unknown} value - 文本。
 * @returns {{ text: string }} 工具返回值。
 */
export function text(value) {
  return { text: String(value) };
}
