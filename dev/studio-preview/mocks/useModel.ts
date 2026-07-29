/** The workspace only needs a model name and id to enable its composer. */
export function useDefaultModel() {
  return { defaultModel: { id: 'preview:deterministic-validator', name: 'Deterministic validation model' } }
}
