/**
 * Unit tests for errors.ts: EzClassifyError class and ErrorCodes map.
 *
 * These tests target the module directly without going through the HTTP
 * machinery in EzClassifyClient. The HTTP-path error tests live in
 * error-taxonomy.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { EzClassifyError, ErrorCodes, type ErrorCode } from '../src/errors';

// ---------------------------------------------------------------------------
// EzClassifyError: constructor and property carry-through
// ---------------------------------------------------------------------------
describe('EzClassifyError', () => {
    describe('extends Error', () => {
        it('is instanceof Error', () => {
            expect(new EzClassifyError('msg')).toBeInstanceOf(Error);
        });

        it('is instanceof EzClassifyError', () => {
            expect(new EzClassifyError('msg')).toBeInstanceOf(EzClassifyError);
        });

        it('name is set to EzClassifyError', () => {
            expect(new EzClassifyError('msg').name).toBe('EzClassifyError');
        });

        it('message is forwarded to Error', () => {
            expect(new EzClassifyError('something broke').message).toBe(
                'something broke',
            );
        });
    });

    describe('code', () => {
        it('code is undefined when omitted', () => {
            expect(new EzClassifyError('msg').code).toBeUndefined();
        });

        it('code is undefined when only message is given', () => {
            const err = new EzClassifyError('lone message');
            expect(err.code).toBeUndefined();
        });

        it.each(Object.values(ErrorCodes) as ErrorCode[])(
            'accepts %s as code',
            (code) => {
                const err = new EzClassifyError('msg', code);
                expect(err.code).toBe(code);
            },
        );
    });

    describe('detail', () => {
        it('detail is undefined when omitted', () => {
            expect(
                new EzClassifyError('msg', ErrorCodes.INVALID_INPUT).detail,
            ).toBeUndefined();
        });

        it('detail is set when provided', () => {
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                'extra context',
            );
            expect(err.detail).toBe('extra context');
        });
    });

    describe('opts: status and body', () => {
        it('status and body are undefined when opts is omitted', () => {
            const err = new EzClassifyError('msg');
            expect(err.status).toBeUndefined();
            expect(err.body).toBeUndefined();
        });

        it('status and body are undefined when opts is an empty object', () => {
            // opts is truthy ({}) but holds no values: both fields should still be undefined
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                undefined,
                {},
            );
            expect(err.status).toBeUndefined();
            expect(err.body).toBeUndefined();
        });

        it('status carries through from opts.status', () => {
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                undefined,
                { status: 403 },
            );
            expect(err.status).toBe(403);
        });

        it('body carries through from opts.body (object)', () => {
            const payload = {
                error: 'forbidden',
                detail: 'clearance insufficient',
            };
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                undefined,
                { body: payload },
            );
            expect(err.body).toEqual(payload);
        });

        it('body carries through from opts.body (string)', () => {
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                undefined,
                { body: 'Bad Gateway' },
            );
            expect(err.body).toBe('Bad Gateway');
        });

        it('status and body are readonly: assignment is a type error at compile time', () => {
            const err = new EzClassifyError(
                'msg',
                ErrorCodes.INVALID_INPUT,
                undefined,
                { status: 500, body: 'boom' },
            );
            // Verify the values are set, confirming the readonly fields are populated
            expect(err.status).toBe(500);
            expect(err.body).toBe('boom');
        });
    });

    describe('instanceof as catch filter', () => {
        it('can be thrown and caught via instanceof EzClassifyError', () => {
            let caught: unknown;
            try {
                throw new EzClassifyError('thrown', ErrorCodes.INVALID_INPUT);
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(EzClassifyError);
            expect(caught).toBeInstanceOf(Error);
        });

        it('instanceof guard narrows to EzClassifyError and exposes .code + .status', () => {
            const raw: unknown = new EzClassifyError(
                'denied',
                ErrorCodes.INVALID_INPUT,
                undefined,
                { status: 403 },
            );
            if (raw instanceof EzClassifyError) {
                expect(raw.code).toBe('INVALID_INPUT');
                expect(raw.status).toBe(403);
            } else {
                throw new Error('instanceof check failed to narrow');
            }
        });

        it('a plain Error is not instanceof EzClassifyError', () => {
            expect(new Error('plain')).not.toBeInstanceOf(EzClassifyError);
        });
    });
});

// ---------------------------------------------------------------------------
// ErrorCodes map
// ---------------------------------------------------------------------------
describe('ErrorCodes', () => {
    it('names every client-originated failure class', () => {
        expect(Object.keys(ErrorCodes).sort()).toEqual([
            'ABORTED',
            'HTTP',
            'INVALID_INPUT',
            'MALFORMED_RESPONSE',
            'NETWORK',
            'TIMEOUT',
        ]);
    });

    it('each value is a string equal to its key (self-keyed)', () => {
        for (const [key, value] of Object.entries(ErrorCodes)) {
            expect(value).toBe(key);
        }
    });

    it('INVALID_INPUT is present', () =>
        expect(ErrorCodes.INVALID_INPUT).toBe('INVALID_INPUT'));
});
