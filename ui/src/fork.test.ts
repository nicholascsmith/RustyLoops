import { describe, expect, it } from 'vitest';
import { en } from './i18n/en';
import { pl } from './i18n/pl';
import { APP_NAME, brand } from './fork';

describe('fork name', () => {
  it('replaces upstream\'s name and its Polish forms, and nothing else', () => {
    expect(brand('Synkopa’s window stopped', true)).toBe('Rusty Loops’s window stopped');
    expect(brand('w Synkopie, do Synkopy, przez Synkopę, z Synkopą', true)).toBe('w Rusty Loops, do Rusty Loops, przez Rusty Loops, z Rusty Loops');
    expect(brand('song.synkopa and Synkopation', true)).toBe('song.synkopa and Synkopation');
  });

  it('leaves no upstream name in any English or Polish message', () => {
    for (const text of [...Object.values(en), ...Object.values(pl)]) expect(brand(text, true)).not.toMatch(/Synkop/);
    expect(APP_NAME).toBe('Rusty Loops');
  });
});
