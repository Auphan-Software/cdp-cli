import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { describeStep, fileInputProblemExpression, parseSteps, scrollExpression, selectExpression, swipePath } from '../../src/video/steps.js';

const run = (expression: string, globals: Record<string, unknown>) => vm.runInNewContext(expression, globals);

describe('scroll, swipe, select and upload steps: parsing', () => {
  it('accepts each new step', () => {
    const doc = parseSteps(JSON.stringify([
      { do: 'scroll', selector: '#list', y: 300 },
      { do: 'scroll', selector: '#strip', x: -120, y: 10, caption: 'Left' },
      { do: 'swipe', from: [200, 300], to: [200, 100] },
      { do: 'swipe', selector: '#card', direction: 'left', distance: 150 },
      { do: 'select', selector: '#size', value: 'large' },
      { do: 'select', selector: '#size', value: '' },
      { do: 'upload', selector: '#file', files: '/tmp/a.txt' },
      { do: 'upload', selector: '#file', files: ['/tmp/a.txt', '/tmp/b.txt'], timeout: 10 }
    ]));
    expect(doc.steps).toHaveLength(8);
    expect(doc.steps[6].files).toEqual(['/tmp/a.txt']);
  });

  it.each([
    ['[{"do":"scroll","y":10}]', /step 1 \(scroll\): needs selector/],
    ['[{"do":"scroll","selector":"#a"}]', /needs selector .* x and\/or y/],
    ['[{"do":"scroll","selector":"#a","y":"10"}]', /x and y are numbers/],
    ['[{"do":"scroll","selector":"#a","x":0,"y":0}]', /must not both be 0/],
    ['[{"do":"scroll","selector":"#a","y":0}]', /must not both be 0/],
    ['[{"do":"scroll","selector":"#a","y":1000000}]', /at most 100000/],
    ['[{"do":"scroll","selector":"#a","y":5,"text":"x"}]', /unknown key text/],
    ['[{"do":"swipe"}]', /step 1 \(swipe\): needs from\/to/],
    ['[{"do":"swipe","to":[1,1],"direction":"up","distance":5}]', /not both/],
    ['[{"do":"swipe","to":[1,1]}]', /to needs a start/],
    ['[{"do":"swipe","from":[1],"to":[1,1]}]', /from must be \[x, y\]/],
    ['[{"do":"swipe","from":[1,1],"to":[-1,1]}]', /to must be \[x, y\]/],
    ['[{"do":"swipe","direction":"sideways","distance":5}]', /direction is one of up, down, left, right/],
    ['[{"do":"swipe","direction":"up"}]', /not both|distance/],
    ['[{"do":"swipe","direction":"up","distance":0}]', /distance is a number/],
    ['[{"do":"select","selector":"#a"}]', /step 1 \(select\): needs selector and value/],
    ['[{"do":"select","value":"x"}]', /needs selector and value/],
    ['[{"do":"upload","selector":"#f"}]', /step 1 \(upload\): needs selector and files/],
    ['[{"do":"upload","selector":"#f","files":[]}]', /needs selector and files/],
    ['[{"do":"upload","selector":"#f","files":[""]}]', /needs selector and files/],
    ['[{"do":"upload","selector":"#f","files":["a"],"timeout":500}]', /timeout/]
  ])('refuses %s with a clear error', (text, error) => {
    expect(() => parseSteps(text)).toThrow(error);
  });

  it('labels a swipe by its direction', () => {
    expect(describeStep({ do: 'swipe', direction: 'up', distance: 10 })).toBe('swipe "up"');
    expect(describeStep({ do: 'select', selector: '#s', value: 'a' })).toBe('select "#s"');
  });
});

describe('scroll expression', () => {
  const make = (el: any) => {
    let t = 0;
    return { document: { querySelector: () => el }, performance: { now: () => t },
      requestAnimationFrame: (f: (n: number) => void) => { t += 100; setImmediate(() => f(t)); } };
  };
  it('eases the container to the delta and reports how far it moved', async () => {
    const el = { scrollLeft: 0, scrollTop: 10, getClientRects: () => [1] };
    expect(await run(scrollExpression({ selector: '#l', y: 300 }), make(el))).toEqual({ moved: [0, 300] });
    expect(el.scrollTop).toBe(310);
  });
  it('fails when the container does not move, waits when it is missing or hidden', async () => {
    const stuck: any = { getClientRects: () => [1], set scrollTop(_v: number) { /* clamped */ }, get scrollTop() { return 0; }, scrollLeft: 0 };
    expect(await run(scrollExpression({ selector: '#l', y: 50 }), make(stuck))).toMatchObject({ fail: expect.stringContaining('did not move') });
    expect(await run(scrollExpression({ selector: '#l', y: 50 }), make(null))).toEqual({ wait: 'not found' });
    expect(await run(scrollExpression({ selector: '#l', y: 50 }), make({ getClientRects: () => [] }))).toEqual({ wait: 'not visible' });
  });
});

describe('select expression', () => {
  const make = (tag: string, values: string[]) => {
    const events: string[] = [];
    const el: any = { tagName: tag, disabled: false, value: values[0], scrollIntoView() {},
      options: values.map((v) => ({ value: v, disabled: false })), dispatchEvent: (e: any) => events.push(e.type) };
    return { el, events, globals: { document: { querySelector: () => el }, Event: class { constructor(public type: string) {} } } };
  };
  it('sets the value and fires input then change', () => {
    const { el, events, globals } = make('SELECT', ['a', 'b']);
    expect(run(selectExpression({ selector: '#s', value: 'b' }), globals)).toEqual({ selected: 'b' });
    expect(el.value).toBe('b');
    expect(events).toEqual(['input', 'change']);
  });
  it('names the problem for a wrong element or an unknown option and fires nothing', () => {
    const wrong = make('DIV', ['a']);
    expect(run(selectExpression({ selector: '#s', value: 'a' }), wrong.globals)).toEqual({ fail: 'is a div, not a select' });
    const none = make('SELECT', ['a', 'b']);
    expect(run(selectExpression({ selector: '#s', value: 'zz' }), none.globals)).toEqual({ fail: 'has no option with value "zz" (options: "a", "b")' });
    expect(none.events).toEqual([]);
  });
});

describe('file input check', () => {
  const check = (el: any, n: number) => run(fileInputProblemExpression('#f', n), { document: { querySelector: () => el } });
  it('accepts an enabled file input and refuses everything else with a reason', () => {
    expect(check({ tagName: 'INPUT', type: 'file', disabled: false, multiple: false }, 1)).toBeNull();
    expect(check({ tagName: 'INPUT', type: 'file', multiple: true }, 3)).toBeNull();
    expect(check(null, 1)).toBe('not found');
    expect(check({ tagName: 'INPUT', type: 'text' }, 1)).toBe('is not an <input type=file>');
    expect(check({ tagName: 'INPUT', type: 'file', disabled: true }, 1)).toBe('is disabled');
    expect(check({ tagName: 'INPUT', type: 'file', multiple: false }, 2)).toMatch(/takes one file/);
  });
});

describe('swipe path', () => {
  const vp = { width: 400, height: 800 };
  it('goes from/to in equal touch moves', () => {
    const path = swipePath({ from: [100, 600], to: [100, 200] }, [0, 0], vp, 4);
    expect(path).toEqual([[100, 600], [100, 500], [100, 400], [100, 300], [100, 200]]);
  });
  it('starts at the given start and goes by direction and distance (the finger moves that way)', () => {
    expect(swipePath({ direction: 'left', distance: 100 }, [300, 400], vp, 2)).toEqual([[300, 400], [250, 400], [200, 400]]);
    expect(swipePath({ direction: 'up', distance: 100 }, [300, 400], vp, 1).at(-1)).toEqual([300, 300]);
    expect(swipePath({ direction: 'down', distance: 100 }, [300, 400], vp, 1).at(-1)).toEqual([300, 500]);
    expect(swipePath({ direction: 'right', distance: 50 }, [300, 400], vp, 1).at(-1)).toEqual([350, 400]);
  });
  it('refuses a point outside the viewport and says which', () => {
    expect(() => swipePath({ direction: 'left', distance: 500 }, [300, 400], vp)).toThrow(/swipe end point \(-200, 400\) is outside the 400x800 viewport/);
    expect(() => swipePath({ from: [900, 10], to: [1, 1] }, [0, 0], vp)).toThrow(/swipe start point/);
  });
});
