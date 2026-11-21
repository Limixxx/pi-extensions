// @ts-ignore
import type { ExtensionAPI, ModelDefinition } from "@mariozechner/pi-coding-agent";

const CONFIG = {
  baseUrl: process.env.LITELLM_BASE_URL?.trim() || "http://i-nhi.zhejianglab.org/maas/v1",
  apiKey: process.env.LITELLM_API_KEY?.trim() || "",
  providerId: "maas",
  // 启动/新建会话时默认选中的模型（可用 LITELLM_DEFAULT_MODEL 覆盖）
  defaultModelId: process.env.LITELLM_DEFAULT_MODEL?.trim() || "GLM-5.3",
  modelDefaults: {
    reasoning: true,
    input: ["text"],
    contextWindow: 102400,
    maxTokens: 100000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }
};

export default async function(pi: ExtensionAPI) {
  // 必需的 LITELLM_API_KEY 未配置时不启用该插件：
  // 不注册 provider、不设置默认模型，仅提示后正常返回，不抛错
  if (!CONFIG.apiKey) {
    // 必须走 stderr：RPC 模式下 stdout 是严格 JSONL 协议流，console.log 会污染协议
    console.error(`未配置 LITELLM_API_KEY 环境变量，跳过 ${CONFIG.providerId} provider 注册（插件未启用）`);
    return;
  }

  try {
    const res = await fetch(`${CONFIG.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${CONFIG.apiKey}` }
    });
    const json = await res.json();
    const rawData = typeof json === 'object' && json !== null ? json.data : undefined;
    const data = Array.isArray(rawData) ? rawData : [];

    const modelList: ModelDefinition[] = data
      .filter((item: any) => item && typeof item.id === 'string')
      .map((item: any) => ({
        id: item.id,
        name: item.id,
        ...CONFIG.modelDefaults
      }));

    if (modelList.length === 0) {
      console.warn(`自定义 ${CONFIG.providerId} provider 未获取到模型列表`);
    }

    pi.registerProvider(CONFIG.providerId, {
      api: "openai-completions",
      baseUrl: CONFIG.baseUrl,
      apiKey: CONFIG.apiKey,
      models: modelList
    });

    // 默认模型：启动或新建会话时自动选中 GLM-5.3（resume/fork 保留原会话模型）
    pi.on("session_start", async (event: any, ctx: any) => {
      if (event?.reason !== "startup" && event?.reason !== "new") return;
      if (!modelList.some((m) => m.id === CONFIG.defaultModelId)) {
        console.warn(`自定义 ${CONFIG.providerId} provider 未发现模型 ${CONFIG.defaultModelId}，跳过默认模型设置`);
        return;
      }
      // registerProvider 在初次加载时是排队生效的，等其落表后再取真实 Model 对象
      let model = ctx?.modelRegistry?.find?.(CONFIG.providerId, CONFIG.defaultModelId);
      if (!model) {
        await new Promise<void>((r) => setTimeout(r, 0));
        model = ctx?.modelRegistry?.find?.(CONFIG.providerId, CONFIG.defaultModelId);
      }
      if (!model) {
        console.warn(`自定义 ${CONFIG.providerId} provider 无法解析模型 ${CONFIG.defaultModelId}`);
        return;
      }
      const ok = await pi.setModel(model);
      if (!ok) console.warn(`设置默认模型 ${CONFIG.providerId}/${CONFIG.defaultModelId} 失败`);
    });

    // 必须走 stderr：RPC 模式下 stdout 是严格 JSONL 协议流，console.log 会污染协议
    console.error(`自定义 ${CONFIG.providerId} provider 注册完成`);
  } catch (error) {
    console.error(`自定义 ${CONFIG.providerId} provider 注册失败:`, error);
    throw error;
  }
}
