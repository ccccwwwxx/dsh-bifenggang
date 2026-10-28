// Exercise the real settings component with a minimal hook/render harness.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
const source = readFileSync(new URL('../src/client/40-settings.js', import.meta.url), 'utf8')
const cells = []
let cursor = 0
let component
let release
let providerCalls = 0
let fail = false
const modelCalls = []
const draft = { strategies: [{ primary: { provider: 'used', model: 'saved-choice' } }] }
const api = {
  get() { throw new Error('refresh must not reload saved config') },
  async providers() {
    providerCalls++
    if (fail) throw new Error('offline')
    await new Promise(resolve => { release = resolve })
    return { providers: [{ id: 'new' }] }
  },
  async models(id) { modelCalls.push(id); return [{ id: 'fresh-' + id }] },
}
const context = vm.createContext({
  React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
  useState(initial) {
    const i = cursor++
    if (!(i in cells)) cells[i] = initial
    return [cells[i], value => { cells[i] = typeof value === 'function' ? value(cells[i]) : value }]
  },
  useRef(initial) { const i = cursor++; return cells[i] ||= { current: initial } },
  useCallback: fn => fn,
  useEffect() {},
  useContainerWidth: () => [null, false],
  StrategyEditor() {}, ModelPicker() {},
})
vm.runInContext(source + '\nthis.renderSettings = PolicySettingsSection', context)
function render() { cursor = 0; component = context.renderSettings({ rpc: api, t: key => key }); return component }
function flatten(node) {
  if (!node || typeof node !== 'object') return []
  return [node, ...(node.children || []).flat(Infinity).flatMap(flatten)]
}
render()
cells[0] = draft
let tree = render()
let button = flatten(tree).find(n => n.children.includes('refreshModels'))
assert.ok(button, 'refresh button is always visible when settings loaded')
const pending = button.props.onClick()
button.props.onClick()
assert.equal(providerCalls, 1, 'duplicate clicks coalesce')
tree = render()
assert.equal(flatten(tree).find(n => n.children.includes('refreshingModels')).props.disabled, true)
release()
// onClick deliberately does not return the async callback; drain its promises.
for (let i = 0; i < 20; i++) await Promise.resolve()
assert.deepEqual(modelCalls.sort(), ['new', 'used'])
assert.equal(cells[0], draft, 'unsaved config identity is preserved')
assert.equal(cells[0].strategies[0].primary.model, 'saved-choice')
tree = render()
assert.equal(flatten(tree).find(n => n.children.includes('refreshModels')).props.disabled, false)
fail = true
flatten(tree).find(n => n.children.includes('refreshModels')).props.onClick()
for (let i = 0; i < 20; i++) await Promise.resolve()
tree = render()
assert.ok(flatten(tree).some(n => n.children.includes('catalogUnavailable')), 'failure is visible')
assert.equal(cells[0], draft)
assert.ok(flatten(tree).some(n => n.type === context.StrategyEditor && n.props.providers.some(p => p.id === 'new')), 'failed refresh preserves prior provider list')
console.log('catalog-refresh: passed (reload, busy, duplicate clicks, draft preservation, failure retention)')
