import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// 设置 › 模型:
// 1. A provider's API 地址 gets the 最近用过的网址 picker (⏲) of the voice backend, the same capability
//    (dsh-tavern-tts endpoint-history.js, its page part published as globalThis[Symbol.for('dsh.endpointHistory')]).
// 2. Google Vertex AI providers (`google-vertex` or `api === 'google-vertex'`) get a 地区 (Region) selector
//    right under the API key field (published as globalThis[Symbol.for('dsh.vertexRegion')]).
// 3. Claude Platform gets default thinking and prompt cache controls under the API key.
// Written against @deepseek-ai/dsh-client-ui-settings-models 0.2.1-rc.2 (DSH Desktop runtime 44.7.0). A host whose
// card no longer has this shape answers `unmatched`: the start and install logs say so, and
// tests/settings-models-endpoints-patch.test.mjs fails on the installed runtime, so an upgrade never drops it silently.
export const SETTINGS_MODELS_PATCHED_VERSION = '0.2.1-rc.2'
const MARKER = '/* dsh-tavern:endpoint-history */'
const VERTEX_REGION_MARKER = '/* dsh-tavern:vertex-region */'
const CLAUDE_OPTIONS_MARKER = '/* dsh-tavern:claude-options */'
// the end of the card's Base URL input: its onChange writes the draft's baseURL, then the jsx call closes.
const BASE_URL_INPUT_END = /setField\("baseURL", event\.target\.value === "" \? void 0 : event\.target\.value\);\s*\}\s*\}\)/g
const PICKER = MARKER + ', globalThis[Symbol.for("dsh.endpointHistory")]?.ModelEndpoints ? (0, react_jsx_runtime.jsx)(globalThis[Symbol.for("dsh.endpointHistory")].ModelEndpoints, '
  + '{ provider: props.provider, label: props.displayName ?? props.provider, ns: namespace.ns, path: settingsPath, keyRef, '
  + 'url: stringAt(fallback, "baseURL") ?? props.defaultBaseURL, disabled, onSwitched: () => props.onClose(true) }) : null'
// right before the collapsed 自定义设置 `<details>` section, directly beneath the API key input.
const DETAILS_START = /props\.credentialOnly === true \? null : \(0, react_jsx_runtime\.jsxs\)\("details", \{/g
const VERTEX_REGION = VERTEX_REGION_MARKER + 'globalThis[Symbol.for("dsh.vertexRegion")]?.VertexRegionField && props.credentialOnly !== true && (props.provider === "google-vertex" || probeApi === "google-vertex") ? (0, react_jsx_runtime.jsx)(globalThis[Symbol.for("dsh.vertexRegion")].VertexRegionField, '
  + '{ provider: props.provider, baseURL: stringAt(draft, "baseURL") ?? "", fallbackBaseURL: stringAt(fallback, "baseURL") ?? "", '
  + 'keyRef, keyDraft, disabled, fieldClassName: ModelsSection_module_css_default["field"], labelClassName: ModelsSection_module_css_default["fieldLabel"], '
  + 'inputClassName: ModelsSection_module_css_default["input"], onChangeBaseURL: (value) => { setField("baseURL", value === "" ? void 0 : value); } }) : null, '

const CLAUDE_OPTIONS = CLAUDE_OPTIONS_MARKER + `props.provider === "anthropic" && props.credentialOnly !== true
  ? [["reasoning", "默认思考强度", [["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "很高"], ["max", "最高"],
      ["off", "关闭（Sonnet 5.5 仅关闭答复前思考）"]]],
    ["cacheRetention", "提示缓存", [["short", "5 分钟"], ["long", "1 小时"], ["none", "关闭"]]]]
    .map(([key, label, choices]) => {
      const baseValue = stringAt(schema.getPath(namespace.base, settingsPath), key);
      const baseLabel = choices.find(([value]) => value === baseValue)?.[1];
      const options = [["", baseLabel ? "默认（" + baseLabel + "）" : "使用默认设置"], ...choices];
      return (0, react_jsx_runtime.jsxs)("label", {
        className: ModelsSection_module_css_default["field"],
        children: [
          (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["fieldLabel"], children: label }),
          (0, react_jsx_runtime.jsx)("select", {
            className: ModelsSection_module_css_default["input"],
            value: stringAt(draft, key) ?? "",
            onChange: event => setField(key, event.target.value),
            disabled,
            children: options.map(([value, text]) => (0, react_jsx_runtime.jsx)("option", { value, children: text }, value))
          })
        ]
      }, key);
    })
  : null, `

export function patchSettingsModelsSource(text) {
  const hasPicker = text.includes(MARKER)
  const hasVertexRegion = text.includes(VERTEX_REGION_MARKER)
  const hasClaudeOptions = text.includes(CLAUDE_OPTIONS_MARKER)
  if (hasPicker && hasVertexRegion && hasClaudeOptions) return { status: 'patched', text }
  let next = text
  if (!hasPicker) {
    const found = [...next.matchAll(BASE_URL_INPUT_END)]
    if (found.length !== 1) return { status: 'unmatched', text }
    const at = found[0].index + found[0][0].length
    next = next.slice(0, at) + PICKER + next.slice(at)
  }
  if (!hasVertexRegion || !hasClaudeOptions) {
    const found = [...next.matchAll(DETAILS_START)]
    if (found.length !== 1) return { status: 'unmatched', text }
    const at = found[0].index
    const controls = (hasVertexRegion ? '' : VERTEX_REGION) + (hasClaudeOptions ? '' : CLAUDE_OPTIONS)
    next = next.slice(0, at) + controls + next.slice(at)
  }
  return { status: 'applied', text: next }
}

/**
 * Patch the host's 设置 › 模型 client in place: true when written, false when already patched, null when this DSH's
 * provider card no longer has the shape (left untouched; the caller says so).
 */
export function patchSettingsModelsEndpoints(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh-client-ui-settings-models') throw new Error('模型设置补丁仅适用于 dsh-client-ui-settings-models')
  const file = path.join(directory, 'lib', 'client.js')
  const result = patchSettingsModelsSource(readFileSync(file, 'utf8'))
  if (result.status === 'unmatched') return null
  if (result.status === 'patched') return false
  writeFileSync(file, result.text)
  return true
}
