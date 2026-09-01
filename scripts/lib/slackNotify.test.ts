import { describe, expect, it, vi } from 'vitest';
import { notifyInstagramMaterial } from './slackNotify';

const baseInput = {
  contentLabel: '店舗記事',
  title: 'テスト店舗',
  articleUrl: 'https://honjikoji.jp/spots/test/',
  imageUrl: 'https://honjikoji.jp/images/instagram/spot-test-feed.webp',
  captionFullText: 'キャプション本文\n\n#本寺小路 #三条市 #新潟グルメ #燕三条',
};

describe('notifyInstagramMaterial', () => {
  it('webhookUrl未設定ならfetchせずスキップする', async () => {
    const fetchImpl = vi.fn();
    const result = await notifyInstagramMaterial({ ...baseInput, webhookUrl: undefined }, fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'not-configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('成功時はsent: trueを返し、必要な情報をすべてblocksに含める', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const result = await notifyInstagramMaterial(
      { ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' },
      fetchImpl
    );
    expect(result).toEqual({ sent: true });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/xxx');
    const body = JSON.parse(init.body);
    const serialized = JSON.stringify(body.blocks);
    expect(serialized).toContain('反映まで数分かかります');
    expect(serialized).toContain(baseInput.title);
    expect(serialized).toContain(baseInput.articleUrl);
    expect(serialized).toContain(baseInput.imageUrl);
    expect(serialized).toContain('#本寺小路');
  });

  it('HTTPエラー時はsent: falseを返す（例外を投げない）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('invalid_payload', { status: 400 }));
    const result = await notifyInstagramMaterial(
      { ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' },
      fetchImpl
    );
    expect(result).toEqual({ sent: false, reason: 'http-400' });
  });

  it('fetch自体が例外を投げてもsent: falseを返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await notifyInstagramMaterial(
      { ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' },
      fetchImpl
    );
    expect(result).toEqual({ sent: false, reason: 'exception' });
  });

  it('imageブロックは使わない（image_urlの到達性検証でメッセージ全体がinvalid_blocksになる実例を確認したため。回帰テスト）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await notifyInstagramMaterial({ ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const types = body.blocks.map((b: { type: string }) => b.type);
    expect(types).not.toContain('image');
  });

  it('画像URL・記事URLは<url|url>形式を使わない（ラベルがURLと完全一致するとSlackがunfurlしない仕様のため。回帰テスト）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await notifyInstagramMaterial({ ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const serialized = JSON.stringify(body.blocks);
    expect(serialized).not.toContain(`<${baseInput.imageUrl}|${baseInput.imageUrl}>`);
    expect(serialized).not.toContain(`<${baseInput.articleUrl}|${baseInput.articleUrl}>`);
    expect(serialized).toContain(`<${baseInput.imageUrl}>`);
    expect(serialized).toContain(`<${baseInput.articleUrl}>`);
  });

  it('キャプション本文をコードブロック（```）で囲まない（Slackモバイルで横スクロールになるため）', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await notifyInstagramMaterial({ ...baseInput, webhookUrl: 'https://hooks.slack.com/services/xxx' }, fetchImpl);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(JSON.stringify(body.blocks)).not.toContain('```');
  });

  it('lengthNoteがある場合はblocksに含める', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    await notifyInstagramMaterial(
      {
        ...baseInput,
        webhookUrl: 'https://hooks.slack.com/services/xxx',
        lengthNote: '字数の目安（150〜250字）から外れています（実際: 300字）。',
      },
      fetchImpl
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(JSON.stringify(body.blocks)).toContain('字数の目安');
  });
});
