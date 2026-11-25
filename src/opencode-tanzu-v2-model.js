/** Shared OpenCode 2.x model conversion for local and Cloud Foundry providers. */

// Kept local (not imported from the capabilities module) so this file stays
// loadable next to an older capabilities module staged by a Cloud Foundry
// buildpack; it mirrors REASONING_EFFORT_VARIANTS there.
const EFFORT_VARIANTS = ["low", "medium", "high"]

export function toV2Model(id, model, released = Date.now()) {
  // A default reasoning effort must not go into `body`. The runtime's own
  // effort variants are `{ settings: { reasoningEffort } }` and `body` is
  // merged after settings, so a body default would silently defeat whichever
  // variant the user picks. Carry it as a setting and offer the same variants.
  const { reasoning_effort: effort, ...body } = model.options ?? {}
  const hasEffort = typeof effort === "string" && effort !== ""
  return {
    modelID: id, name: model.name, family: model.family ?? id,
    capabilities: { tools: model.tool_call === true, input: model.modalities?.input ?? ["text"], output: model.modalities?.output ?? ["text"] },
    limit: { ...model.limit }, status: "active", time: { released },
    ...(Object.keys(body).length ? { body } : {}),
    ...(hasEffort
      ? {
          settings: { reasoningEffort: effort },
          variants: EFFORT_VARIANTS.map((level) => ({ id: level, settings: { reasoningEffort: level } })),
        }
      : {}),
  }
}

// Native request composition applies the selected variant after this model body.
// Preserve operator fields (including zero and null), without mutating defaults.
export function mergeV2Model(id, model, released, draft = {}, provider = {}) {
  const converted = toV2Model(id, model, released)
  if (converted.body || provider.body || draft.body) {
    converted.body = { ...converted.body, ...provider.body, ...draft.body }
  }
  // An operator's own model settings win over the bundled default, key by key.
  if (converted.settings || draft.settings) {
    converted.settings = { ...converted.settings, ...draft.settings }
  }
  // Variants the model already has (the runtime's or the operator's) are
  // authoritative; ours are only a fallback for a model that has none.
  if (Array.isArray(draft.variants) && draft.variants.length > 0) delete converted.variants
  return converted
}
