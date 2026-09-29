import { redactSensitive } from './redact.util';

describe('redactSensitive', () => {
  it('redacts known sensitive keys case-insensitively', () => {
    expect(
      redactSensitive({
        email: 'a@b.com',
        password: 'hunter2',
        apiKey: 'sk_live',
        nested: { token: 'abc', keep: 1 },
      }),
    ).toEqual({
      email: 'a@b.com',
      password: '[REDACTED]',
      apiKey: '[REDACTED]',
      nested: { token: '[REDACTED]', keep: 1 },
    });
  });

  it('redacts inside arrays', () => {
    expect(redactSensitive([{ secret: 'x' }, { ok: true }])).toEqual([
      { secret: '[REDACTED]' },
      { ok: true },
    ]);
  });
});
