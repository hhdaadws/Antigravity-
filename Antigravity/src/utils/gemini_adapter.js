import { generateRequestId, generateSessionId, generateProjectId } from './utils.js';
import config from '../config/config.js';

/**
 * 将 Gemini 原生格式的 contents 转换为 Antigravity 格式的 messages
 */
function geminiContentsToAntigravity(contents) {
  const antigravityMessages = [];

  for (const content of contents) {
    const role = content.role === 'user' ? 'user' : 'model';
    const parts = [];

    for (const part of content.parts) {
      // 复制 part 对象
      const cleanedPart = { ...part };

      // 移除 thought_signature：
      // 1. 来自客户端的历史消息中的签名可能来自其他环境（如官方 CLI）
      // 2. 跨环境/跨 token 使用签名会导致 "Corrupted thought signature" 错误
      // 3. Antigravity 响应中生成的新签名由客户端在下一轮保留即可
      if (cleanedPart.thought_signature !== undefined) {
        delete cleanedPart.thought_signature;
      }

      // 同样处理 functionCall 内部的 thought_signature
      if (cleanedPart.functionCall?.thought_signature !== undefined) {
        delete cleanedPart.functionCall.thought_signature;
      }

      parts.push(cleanedPart);
    }

    antigravityMessages.push({ role, parts });
  }

  return antigravityMessages;
}

/**
 * 将 Gemini 的 tools 转换为 Antigravity 格式
 */
function geminiToolsToAntigravity(tools) {
  if (!tools || tools.length === 0) return [];

  return tools.map(tool => {
    if (tool.functionDeclarations) {
      // 清理每个 functionDeclaration，移除不兼容的字段
      const cleanedDeclarations = tool.functionDeclarations.map(decl => {
        const cleaned = { ...decl };

        // Antigravity 不接受 $schema 字段
        if (cleaned.parameters && cleaned.parameters.$schema) {
          delete cleaned.parameters.$schema;
        }

        return cleaned;
      });

      return {
        functionDeclarations: cleanedDeclarations
      };
    }
    return tool;
  });
}

/**
 * 生成 Antigravity 请求体（从 Gemini 格式）
 */
export function generateAntigravityRequestFromGemini(geminiRequest, modelName) {
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium";

  const generationConfig = geminiRequest.generationConfig || {};

  const antigravityConfig = {
    topP: generationConfig.topP ?? config.defaults.top_p,
    topK: generationConfig.topK ?? config.defaults.top_k,
    temperature: generationConfig.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: generationConfig.maxOutputTokens ?? config.defaults.max_tokens,
    stopSequences: generationConfig.stopSequences || [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  };

  if (enableThinking && modelName.includes("claude")) {
    delete antigravityConfig.topP;
  }

  return {
    project: generateProjectId(),
    requestId: generateRequestId(),
    request: {
      contents: geminiContentsToAntigravity(geminiRequest.contents || []),
      systemInstruction: geminiRequest.systemInstruction || {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      },
      tools: geminiToolsToAntigravity(geminiRequest.tools || []),
      toolConfig: geminiRequest.toolConfig || {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: antigravityConfig,
      sessionId: geminiRequest.sessionId || generateSessionId()
    },
    model: modelName,
    userAgent: "antigravity"
  };
}

/**
 * 清理响应中的 thought_signature（避免跨环境污染）
 */
function cleanResponseThoughtSignature(data) {
  if (!data.response?.candidates) return data;

  const cleanedData = JSON.parse(JSON.stringify(data));

  for (const candidate of cleanedData.response.candidates) {
    if (candidate.content?.parts) {
      for (const part of candidate.content.parts) {
        // 移除 part 级别的 thought_signature
        if (part.thought_signature !== undefined) {
          delete part.thought_signature;
        }

        // 移除 functionCall 内部的 thought_signature
        if (part.functionCall?.thought_signature !== undefined) {
          delete part.functionCall.thought_signature;
        }
      }
    }
  }

  return cleanedData;
}

/**
 * 将 Antigravity 的 SSE 响应转换为 Gemini 格式
 */
export function convertAntigravityToGeminiSSE(data) {
  // 清理 thought_signature 避免跨环境使用时报错
  // 用户可能在官方 CLI 和 Antigravity 之间切换，签名是环境绑定的
  return cleanResponseThoughtSignature(data);
}
