const https = require('https');
const config = require('../config');

let cachedModels = null;
let lastFetch = 0;
const CACHE_TTL = 300000;

function fetchModels() {
  return new Promise((resolve, reject) => {
    const apiKey = config.get('API_KEY');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const req = https.get('https://openrouter.ai/api/v1/models', { headers }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const list = parsed.data || parsed;
          if (!Array.isArray(list)) return reject(new Error('Unexpected response format'));
          cachedModels = list;
          lastFetch = Date.now();
          resolve(list);
        } catch (e) {
          reject(new Error('Failed to parse model list: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function getModelList(forceRefresh = false) {
  if (forceRefresh || !cachedModels || Date.now() - lastFetch > CACHE_TTL) {
    try {
      return await fetchModels();
    } catch (e) {
      if (cachedModels) return cachedModels;
      throw e;
    }
  }
  return cachedModels;
}

async function findModel(modelId) {
  const list = await getModelList();
  return list.find(m => m.id === modelId) || null;
}

async function supportsVision(modelId) {
  const model = await findModel(modelId);
  if (!model) return null;
  const modalities = model.input_modalities || [];
  return modalities.includes('image');
}

async function supportsReasoning(modelId) {
  const model = await findModel(modelId);
  if (!model) return null;
  const params = model.supported_parameters || [];
  return params.includes('reasoning') || params.includes('include_reasoning');
}

async function supportsTools(modelId) {
  const model = await findModel(modelId);
  if (!model) return null;
  const params = model.supported_parameters || [];
  return params.includes('tools');
}

async function getModelContextLength(modelId) {
  const model = await findModel(modelId);
  return model ? (model.context_length || null) : null;
}

async function getModelPricing(modelId) {
  const model = await findModel(modelId);
  if (!model || !model.pricing) return null;
  return {
    prompt: parseFloat(model.pricing.prompt) || 0,
    completion: parseFloat(model.pricing.completion) || 0,
    request: parseFloat(model.pricing.request) || 0
  };
}

async function listModelsByCapability(opts = {}) {
  let list = await getModelList();
  if (opts.vision) list = list.filter(m => (m.input_modalities || []).includes('image'));
  if (opts.reasoning) list = list.filter(m => (m.supported_parameters || []).includes('reasoning'));
  if (opts.free) list = list.filter(m => {
    const p = m.pricing;
    if (!p) return false;
    return parseFloat(p.prompt) === 0 && parseFloat(p.completion) === 0;
  });
  if (opts.maxPrice) {
    list = list.filter(m => {
      const p = m.pricing;
      if (!p) return false;
      return parseFloat(p.prompt) <= opts.maxPrice && parseFloat(p.completion) <= opts.maxPrice;
    });
  }
  return list;
}

function invalidateCache() {
  cachedModels = null;
  lastFetch = 0;
}

async function getModelMap() {
  const list = await getModelList();
  const map = {};
  for (const m of list) {
    map[m.id] = m;
  }
  return map;
}

module.exports = {
  getModelList,
  findModel,
  supportsVision,
  supportsReasoning,
  supportsTools,
  getModelContextLength,
  getModelPricing,
  listModelsByCapability,
  invalidateCache,
  getModelMap
};
