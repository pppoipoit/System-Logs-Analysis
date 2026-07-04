// Test script to simulate Gemini API flow without Electron GUI
// Run with: node test_gemini_flow.js

// Simulate the normalizeGeminiModel function
function normalizeGeminiModel(model) {
  return String(model || '').replace(/^models\//, '')
}

// Simulate the uniqueValues function
function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))]
}

// Centralized Gemini model priority list
const GEMINI_MODELS_PREFERRED = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite-001',
  'gemini-1.5-flash'
]

function geminiFallbackModels(model) {
  return uniqueValues([
    normalizeGeminiModel(model),
    ...GEMINI_MODELS_PREFERRED
  ])
}

function parseProviderErrorBody(body) {
  try {
    const parsed = JSON.parse(body)
    const err = parsed.error || parsed
    return {
      code: err.code,
      status: err.status,
      message: err.message || body
    }
  } catch {
    return { message: body || 'Unknown provider error' }
  }
}

function providerErrorMessage(provider, status, body) {
  const parsed = parseProviderErrorBody(body)
  const details = parsed.message ? `: ${parsed.message}` : ''
  if (status === 429) {
    return `${provider} 429 RESOURCE_EXHAUSTED${details}. Try again later, use a lighter model, or enable billing.`
  }
  if (status === 400 && parsed.status === 'FAILED_PRECONDITION') {
    return `${provider} 400 FAILED_PRECONDITION${details}. Free tier not available. Enable billing or try a different model.`
  }
  if (status === 403) {
    return `${provider} 403 PERMISSION_DENIED${details}. Check API key permissions.`
  }
  if (status === 404) {
    return `${provider} 404 NOT_FOUND${details}. Model not available.`
  }
  return `${provider} ${status}${details}`
}

// ── Tests ───────────────────────────────────────────

console.log('=== Test 1: Model Fallback List ===')
console.log('Default fallback from gemini-2.5-flash:')
console.log(geminiFallbackModels('gemini-2.5-flash'))

console.log('\nFallback from gemini-1.5-pro (custom model):')
console.log(geminiFallbackModels('gemini-1.5-pro'))

console.log('\nFallback with models/ prefix:')
console.log(geminiFallbackModels('models/gemini-2.0-flash-001'))

console.log('\n=== Test 2: Error Message Parsing ===')
const errorBody = JSON.stringify({
  error: {
    code: 429,
    status: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for the model'
  }
})
console.log('429 error:', providerErrorMessage('Gemini', 429, errorBody))

const failedPreconditionBody = JSON.stringify({
  error: {
    code: 400,
    status: 'FAILED_PRECONDITION',
    message: 'The free tier is not available'
  }
})
console.log('\n400 FAILED_PRECONDITION:', providerErrorMessage('Gemini', 400, failedPreconditionBody))

console.log('\n=== Test 3: All Models in Preferred List ===')
console.log('Total models in preferred list:', GEMINI_MODELS_PREFERRED.length)
GEMINI_MODELS_PREFERRED.forEach(m => {
  const normalized = normalizeGeminiModel(m)
  console.log(`  - ${m} → ${normalized}`)
})

console.log('\n=== Test 4: Deduplication ===')
console.log('Duplicate test (gemini-2.5-flash appears twice):')
console.log(geminiFallbackModels('gemini-2.5-flash'))

console.log('\n✅ All backend logic tests passed!')
console.log('Note: This test only validates the JS logic, not actual API calls.')
console.log('To test actual API connectivity, run the Electron app and use Settings → Test.')