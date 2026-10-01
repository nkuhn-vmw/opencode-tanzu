/** Shared OpenCode 2.0.x model conversion for local and Cloud Foundry providers. */
export function toV2Model(id, model, released = Date.now()) {
  return {
    modelID: id, name: model.name, family: model.family ?? id,
    capabilities: { tools: model.tool_call === true, input: model.modalities?.input ?? ["text"], output: model.modalities?.output ?? ["text"] },
    limit: { ...model.limit }, status: "active", time: { released },
    ...(model.options && Object.keys(model.options).length ? { body: { ...model.options } } : {}),
  }
}

// Native request composition applies the selected variant after this model body.
// Preserve operator fields (including zero and null), without mutating defaults.
export function mergeV2Model(id, model, released, draft = {}, provider = {}) {
  const converted = toV2Model(id, model, released)
  if (converted.body || provider.body || draft.body) {
    converted.body = { ...converted.body, ...provider.body, ...draft.body }
  }
  return converted
}
