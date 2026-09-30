import 'reflect-metadata';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { DeprecationInterceptor } from './deprecation.interceptor';
import { Deprecated, DeprecatedOptions } from '../decorators/deprecated.decorator';

const OPTIONS: DeprecatedOptions = {
  sunsetDate: '2027-01-01',
  link: '/docs/api-versioning',
  message: 'Use v2.',
};

class LegacyController {
  @Deprecated(OPTIONS)
  legacy(): void {}
}

class CurrentController {
  current(): void {}
}

describe('DeprecationInterceptor', () => {
  let interceptor: DeprecationInterceptor;
  let setHeader: jest.Mock;

  const next: CallHandler = { handle: () => of('body') };

  beforeEach(() => {
    interceptor = new DeprecationInterceptor(new Reflector());
    setHeader = jest.fn();
  });

  function contextFor(cls: unknown, handler: (...args: any[]) => void): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
    } as unknown as ExecutionContext;
  }

  it('sets RFC 8594 headers on a @Deprecated() handler', async () => {
    const ctx = contextFor(LegacyController, LegacyController.prototype.legacy);

    await expect(firstValueFrom(interceptor.intercept(ctx, next))).resolves.toBe('body');

    expect(setHeader).toHaveBeenCalledWith('Deprecation', 'true');
    expect(setHeader).toHaveBeenCalledWith('Sunset', OPTIONS.sunsetDate);
    expect(setHeader).toHaveBeenCalledWith('Link', `${OPTIONS.link}; rel="successor-version"`);
    expect(setHeader).toHaveBeenCalledWith('X-Deprecation-Notice', OPTIONS.message);
  });

  it('sets no headers on a handler without @Deprecated()', async () => {
    const ctx = contextFor(CurrentController, CurrentController.prototype.current);

    await expect(firstValueFrom(interceptor.intercept(ctx, next))).resolves.toBe('body');

    expect(setHeader).not.toHaveBeenCalled();
  });
});
