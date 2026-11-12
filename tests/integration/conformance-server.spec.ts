/**
 * The same corpus, over real HTTP, through the client's real transport.
 *
 * The fast lane replaces `fetch` and proves the client builds the right
 * request. It cannot prove the request survives the trip: header casing, the
 * query string as an HTTP server parses it, a status the platform's fetch
 * treats specially, a body the client streams rather than sends. This lane runs
 * the same drivers against `@ezclassify/conformance-server`, which answers real
 * sockets out of the same recording and refuses everything else with a
 * diagnostic rather than an answer.
 *
 * It is a separate script from `npm test` because it binds a port. Nothing in
 * it is a different assertion from the fast lane; it is the same assertions
 * with the transport left in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    TEST_BEARER_TOKEN,
    loadCorpus,
    startConformanceServer,
} from '@ezclassify/conformance-server';
import type { ConformanceServer } from '@ezclassify/conformance-server';
import { EzClassifyClient } from '../../src/ezclassify-client';
import { EzClassifyError } from '../../src/errors';
import { loadWireCorpus } from '../wire-corpus';
import type { DriverOutcome } from '../wire-drivers';
import { WIRE_DRIVERS, buildClient } from '../wire-drivers';

const corpus = loadWireCorpus();

/**
 * The cases this server will answer from: the open deployment's recordings,
 * with every refusal removed. A refusal is not an operation, and the server
 * produces those from its own auth mode instead of matching a request to one.
 */
const servable = new Set(
    loadCorpus(corpus.file).servable.map((entry) => entry.id),
);

/**
 * The drivers whose every case the server can answer.
 *
 * Read off the server's own servable set rather than listed by hand, so a
 * corpus that starts or stops recording something moves this lane with it.
 */
const SERVER_LANE = Object.entries(WIRE_DRIVERS).filter(([, driver]) =>
    driver.cases.every((caseId) => servable.has(caseId)),
);

describe('conformance server: the corpus over real HTTP', () => {
    let server: ConformanceServer;

    beforeAll(async () => {
        server = await startConformanceServer({
            corpus: corpus.file,
            log: null,
            port: 0,
        });
    });

    afterAll(async () => {
        await server?.stop();
    });

    it('serves the corpus this client replayed in the fast lane', () => {
        expect(server.corpus.corpusVersion).toBe(corpus.corpusVersion);
        expect(server.corpus.file).toBe(corpus.file);
        expect(SERVER_LANE.length).toBeGreaterThan(0);
    });

    for (const [name, driver] of SERVER_LANE) {
        it(`${name}: ${driver.cases.join(', ')}`, async () => {
            const client = buildClient(driver.binding, server.url);
            let outcome: DriverOutcome;
            try {
                outcome = {
                    settled: 'resolved',
                    value: await driver.run(client),
                };
            } catch (error) {
                outcome = { settled: 'rejected', error };
            } finally {
                client.destroy();
            }
            driver.verify(outcome, (caseId) => {
                const recorded = corpus.byId.get(caseId);
                if (!recorded) throw new Error(`no corpus case ${caseId}`);
                return recorded;
            });
        });
    }

    it('refuses a request nobody recorded, with a status the wire never uses', async () => {
        const client = buildClient('ctx:ez-full', server.url);
        try {
            // A marking the corpus does not carry. There is no engine here to
            // compute an answer, and saying 404 would be indistinguishable from
            // the runtime answering a missing resource.
            await expect(
                client.scheme.process('NOTHING-RECORDED-FOR-THIS'),
            ).rejects.toMatchObject({ status: 501 });
        } finally {
            client.destroy();
        }
    });
});

describe('conformance server: authentication discrimination', () => {
    let server: ConformanceServer;

    /** The refusal bytes the corpus recorded, which the server serves verbatim. */
    const recordedDenial = () => {
        const recorded = corpus.byId.get('denial.authenticated-no-credential');
        if (!recorded) throw new Error('the corpus records no refusal');
        return recorded.response;
    };

    beforeAll(async () => {
        server = await startConformanceServer({
            auth: 'simulated',
            corpus: corpus.file,
            log: null,
            port: 0,
        });
    });

    afterAll(async () => {
        await server?.stop();
    });

    it('answers a request carrying the accepted credential', async () => {
        const client = new EzClassifyClient(server.url, {
            auth: { token: TEST_BEARER_TOKEN },
            contextId: 'ez-full',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
        });
        try {
            const processed = await client.scheme.process('OPEN');
            expect(processed).toEqual(
                (
                    corpus.byId.get('ctx-scheme-process.ok')?.response.body as {
                        result: unknown;
                    }
                ).result,
            );
        } finally {
            client.destroy();
        }
    });

    it('flags the constant refusal when the client holds a credential', async () => {
        const client = new EzClassifyClient(server.url, {
            auth: { token: 'a-bearer-no-deployment-accepts' },
            contextId: 'ez-full',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
        });
        try {
            const error = await client.scheme.process('OPEN').then(
                () => {
                    throw new Error('the refused credential was answered');
                },
                (caught: unknown) => caught as EzClassifyError,
            );
            expect(error).toBeInstanceOf(EzClassifyError);
            expect(error.status).toBe(recordedDenial().status);
            expect(error.body).toEqual(recordedDenial().body);
            expect(error.possiblyUnauthenticated).toBe(true);
            // The wording is the whole point of the flag: the caller has to be
            // sent to the credential rather than to the route table.
            expect(error.message).toMatch(/check the caller credentials/);
        } finally {
            client.destroy();
        }
    });

    it('does not flag the same bytes for a client that holds no credential', async () => {
        const client = new EzClassifyClient(server.url, {
            contextId: 'ez-full',
            contextVersion: '1.0.0',
        });
        try {
            const error = await client.scheme.process('OPEN').then(
                () => {
                    throw new Error('an unauthenticated request was answered');
                },
                (caught: unknown) => caught as EzClassifyError,
            );
            // Byte-identical to the refusal above. Everything a caller can see
            // is the same; the only thing that differs is what the client knows
            // about itself, and that is what it is allowed to say.
            expect(error.status).toBe(recordedDenial().status);
            expect(error.body).toEqual(recordedDenial().body);
            expect(error.possiblyUnauthenticated).toBeUndefined();
        } finally {
            client.destroy();
        }
    });

    it('reaches liveness without a credential, so a probe still works', async () => {
        const client = new EzClassifyClient(server.url);
        try {
            const ping = await client.ping();
            expect(ping.engineVersion).toBe(
                (
                    corpus.byId.get('health.ok')?.response.body as {
                        engineVersion: string;
                    }
                ).engineVersion,
            );
        } finally {
            client.destroy();
        }
    });

    it('answers a Context operation once the accepted credential is presented', async () => {
        const client = new EzClassifyClient(server.url, {
            auth: { token: TEST_BEARER_TOKEN },
            contextId: 'ez-full',
            contextToken: 'conformance-context-carrier',
            contextVersion: '1.0.0',
        });
        try {
            const processed = await client.scheme.process('OPEN');
            expect(processed).toEqual(
                (
                    corpus.byId.get('ctx-scheme-process.ok')?.response.body as {
                        result: unknown;
                    }
                ).result,
            );
        } finally {
            client.destroy();
        }
    });
});
