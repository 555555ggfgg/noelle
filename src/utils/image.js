const fs = require('fs');
const sharp = require('sharp');
const config = require('../config');
const { supportsVision } = require('./models');

async function imageToBase64(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const jpegBuffer = await sharp(buffer)
    .resize({ width: config.get('MAX_IMAGE_SIZE'), withoutEnlargement: true })
    .jpeg({ quality: config.get('IMAGE_QUALITY') })
    .toBuffer();
  return jpegBuffer.toString('base64');
}

let VISION_MODELS = null;

function getVisionModels() {
  if (VISION_MODELS) return VISION_MODELS;
  const configValue = config.get('VISION_MODELS');
  try {
    VISION_MODELS = configValue ? JSON.parse(configValue) : [
      'vl', 'vision', 'gpt-4o', 'gpt-4', 'gemini', 'claude', 'qwen', 'glm-4v', 'glm-5v',
      'llama-3.2-vision', 'llama-4', 'minicpm', 'pixtral', 'mistral-vl',
      'step-3', 'reka-core', 'idefics', 'fuyu', 'moondream', 'phi-3-vision',
      'phi-4-vision', 'internvl', 'internlm-xcomposer', 'cogvlm', 'deepseek-vl',
      'gemma-3-vision', 'paligemma', 'kosmos', 'florence', 'solar-vl', 'smolvlm',
      'mplug', 'xcomposer', 'llava', 'cambrian', 'vlm'
    ];
  } catch (e) {
    VISION_MODELS = ['vl', 'vision', 'gpt-4o', 'gpt-4', 'gemini', 'claude', 'qwen'];
  }
  return VISION_MODELS;
}

function isVisionModel(modelName) {
  if (!modelName) return false;
  return getVisionModels().some(m => modelName.toLowerCase().includes(m));
}

async function isVisionModelAsync(modelName) {
  if (!modelName) return false;
  if (config.get('BACKEND_TYPE') === 'api') {
    try {
      const result = await supportsVision(modelName);
      if (result === true) return true;
      if (result === false) return false;
    } catch (e) {}
  }
  return isVisionModel(modelName);
}

module.exports = { imageToBase64, isVisionModel, isVisionModelAsync };
