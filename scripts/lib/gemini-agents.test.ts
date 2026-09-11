import { describe, expect, it, vi } from 'vitest';
import type { GoogleGenAI } from '@google/genai';
import { callGroundedJsonAgent, logGroundingSources } from './gemini-agents';

/** テスト用に必要最小限のGenerateContentResponse形（as anyでキャスト）。 */
function fakeResponse(text: string, groundingChunks: Array<{ web?: { uri?: string; title?: string } }> = []) {
  return {
    text,
    candidates: [{ groundingMetadata: { groundingChunks } }],
  } as any;
}

describe('logGroundingSources', () => {
  it('URL付きのgroundingChunksが無ければ0を返し、ログも出さない', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const count = logGroundingSources(fakeResponse('{}', []), '[test]');
    expect(count).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('web.uriを持たないchunkは件数に含めない', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const count = logGroundingSources(fakeResponse('{}', [{ web: {} }, { web: { title: 'no uri' } }]), '[test]');
    expect(count).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('URL付きのgroundingChunksの件数を返し、内容をログに出す（回帰テスト: Wine Bar MARGAUXの件でこの件数が0だったことがハルシネーション検知の唯一の手がかりだった）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const count = logGroundingSources(
      fakeResponse('{}', [
        { web: { uri: 'https://example.com/a', title: 'A' } },
        { web: { uri: 'https://example.com/b', title: 'B' } },
        { web: {} },
      ]),
      '[test]'
    );
    expect(count).toBe(2);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('参照した情報源 (2件)'));
    logSpy.mockRestore();
  });
});

describe('callGroundedJsonAgent', () => {
  it('成功時、テキストとgroundingSourceCountの両方を返す', async () => {
    const generateContent = vi
      .fn()
      .mockResolvedValue(fakeResponse('{"ok":true}', [{ web: { uri: 'https://example.com/a' } }]));
    const ai = { models: { generateContent } } as unknown as GoogleGenAI;

    const result = await callGroundedJsonAgent(ai, {
      label: '[test]',
      prompt: 'テストプロンプト',
      responseSchema: {},
    });

    expect(result).toEqual({ text: '{"ok":true}', groundingSourceCount: 1 });
  });

  it('Grounding引用が0件でも例外を投げず、groundingSourceCount: 0を返す（呼び出し元がハルシネーション対策として判定する）', async () => {
    const generateContent = vi.fn().mockResolvedValue(fakeResponse('{"ok":true}', []));
    const ai = { models: { generateContent } } as unknown as GoogleGenAI;

    const result = await callGroundedJsonAgent(ai, {
      label: '[test]',
      prompt: 'テストプロンプト',
      responseSchema: {},
    });

    expect(result).toEqual({ text: '{"ok":true}', groundingSourceCount: 0 });
  });

  it('構造化出力とGroundingの併用が拒否された場合、プレーンJSONモードにフォールバックしてもgroundingSourceCountを返す', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const schemaConflictError = new Error('{"code": 400, "message": "tool and response_schema cannot both be set"}');
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(schemaConflictError)
      .mockResolvedValueOnce(fakeResponse('```json\n{"ok":true}\n```', [{ web: { uri: 'https://example.com/a' } }]));
    const ai = { models: { generateContent } } as unknown as GoogleGenAI;

    const result = await callGroundedJsonAgent(ai, {
      label: '[test]',
      prompt: 'テストプロンプト',
      responseSchema: {},
    });

    expect(result).toEqual({ text: '{"ok":true}', groundingSourceCount: 1 });
    expect(generateContent).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
