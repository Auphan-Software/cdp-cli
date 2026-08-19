import { describe, expect, it } from 'vitest';
import { TargetRegistry, redactTargetUrl } from '../../../src/cdp/target-registry.js';

describe('TargetRegistry', () => {
  it('redacts target URLs and URL-shaped titles before storing them', () => {
    const registry = new TargetRegistry();
    registry.upsertTarget({
      targetId: 'page',
      type: 'page',
      title: 'Checkout https://pay.example/form?token=title-secret#step',
      url: 'https://user:password@shop.example/checkout?token=url-secret#card',
      attached: false,
      browserContextId: 'profile-1'
    });

    const target = registry.getByTargetId('page');
    expect(target?.url).toBe('https://shop.example/checkout');
    expect(target?.title).toBe('Checkout https://pay.example/form');
    expect(JSON.stringify(target)).not.toContain('secret');
    expect(registry.getByBrowserContextId('profile-1')).toHaveLength(1);
  });

  it('indexes sessions and OOPIF parent topology and cleans lifecycle state', () => {
    const registry = new TargetRegistry();
    registry.attachSession('page-session', {
      targetId: 'page-frame',
      type: 'page',
      title: 'Checkout',
      url: 'https://shop.example/'
    });
    registry.attachSession('iframe-session', {
      targetId: 'card-frame',
      type: 'iframe',
      title: 'Card',
      url: 'https://pay.example/field?token=secret',
      parentId: 'page-frame',
      parentFrameId: 'page-frame',
      browserContextId: 'profile-1'
    }, 'page-session');

    expect(registry.getBySessionId('iframe-session')).toMatchObject({
      targetId: 'card-frame',
      parentTargetId: 'page-frame',
      parentSessionId: 'page-session',
      parentFrameId: 'page-frame'
    });
    expect(registry.getByParentFrameId('page-frame').map((target) => target.targetId))
      .toEqual(['card-frame']);
    expect(registry.childrenOf('page-frame').map((target) => target.targetId))
      .toEqual(['card-frame']);

    registry.detachSession('iframe-session');
    expect(registry.getBySessionId('iframe-session')).toBeUndefined();
    expect(registry.getByTargetId('card-frame')?.sessionId).toBeUndefined();
    registry.removeTarget('card-frame');
    expect(registry.getByParentFrameId('page-frame')).toEqual([]);
  });

  it('matches an iframe by exact child frame id and never by parentFrameId', () => {
    const registry = new TargetRegistry();
    registry.upsertTarget({
      targetId: 'real-child-frame',
      type: 'iframe',
      title: '',
      url: 'https://pay.example/',
      parentId: 'page',
      parentFrameId: 'decoy-frame-id'
    });

    expect(registry.findTargetForFrame('real-child-frame', 'page')?.targetId)
      .toBe('real-child-frame');
    expect(registry.findTargetForFrame('decoy-frame-id', 'page')).toBeUndefined();
    expect(registry.findTargetForFrame('real-child-frame', 'different-parent')).toBeUndefined();
  });

  it('prefers the system-unique default context for the target own frame', () => {
    const registry = new TargetRegistry();
    registry.attachSession('page-session', {
      targetId: 'page-frame',
      type: 'page',
      title: '',
      url: 'about:blank'
    });
    registry.recordExecutionContext('page-session', {
      id: 10,
      uniqueId: 'unique-page',
      auxData: { isDefault: true, type: 'default', frameId: 'page-frame' }
    });
    registry.recordExecutionContext('page-session', {
      id: 11,
      uniqueId: 'unique-same-process-child',
      auxData: { isDefault: true, type: 'default', frameId: 'child-frame' }
    });

    expect(registry.getDefaultExecutionContext('page-session')).toMatchObject({
      id: 10,
      uniqueId: 'unique-page',
      frameId: 'page-frame'
    });
    registry.removeExecutionContext('page-session', undefined, 'unique-page');
    expect(registry.getDefaultExecutionContext('page-session')).toBeUndefined();
  });
});

describe('redactTargetUrl', () => {
  it.each([
    ['https://example.com/path?a=1#frag', 'https://example.com/path'],
    ['about:blank?secret#frag', 'about:blank'],
    ['data:text/html,secret?token=1', 'data:[redacted]'],
    ['blob:https://example.com/id?secret=1#frag', 'blob:https://example.com/id']
  ])('redacts %s', (raw, expected) => {
    expect(redactTargetUrl(raw)).toBe(expected);
  });
});
