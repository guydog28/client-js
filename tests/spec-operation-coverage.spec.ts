/**
 * The vendored contract decides what this client owes; this file checks it
 * paid.
 *
 * `vendor/spec/openapi.yaml` is the authority for the REST surface. Two things
 * are held here, both by running the corpus drivers rather than by reading a
 * table someone keeps in step by hand:
 *
 * - Every operation the contract declares goes on the wire from a public call. A
 *   driver that reaches a member whose name starts with `_` does not count, so
 *   an operation only the request transport can send fails the run. The one
 *   operation the client deliberately never sends is in {@link NOT_SENT}.
 * - A corpus case that only the request transport can drive is listed in
 *   {@link PRIVATE_SEAM}, under the one reason that covers it. A new case driven
 *   that way fails until someone files it under a reason, and a listed case
 *   that a public call now drives fails until it is taken off the list.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { beforeAll, describe, expect, it } from 'vitest';
import type { EzClassifyClient } from '../src/ezclassify-client';
import { EzClassifyError } from '../src/errors';
import { loadWireCorpus } from './wire-corpus';
import { ReplayTransport } from './wire-replay-transport';
import { WIRE_DRIVERS, buildReplayClient } from './wire-drivers';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = resolve(here, '../vendor/spec/openapi.yaml');
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Contract operations this client never sends, and why. */
const NOT_SENT: Readonly<Record<string, string>> = {
    getReady:
        'A readiness probe answers an orchestrator; ping() sends getHealth, which carries the engine version a caller can use.',
};

/**
 * Corpus cases driven only through the client's request transport, grouped by
 * the reason no public call can emit them.
 */
const PRIVATE_SEAM: ReadonlyArray<{
    reason: string;
    cases: readonly string[];
}> = [
    {
        reason: 'The typed signature cannot build this body or query, so the runtime refusal of a hand-built request is replayed raw.',
        cases: [
            'ctx-document-audit.undeclared-guide-field',
            'ctx-scheme-aggregate.input-format-with-sets',
            'ctx-scheme-aggregate.undeclared-field',
            'ctx-scheme-explain.undeclared-field',
            'ctx-scheme-label-presets.undeclared-query-parameter',
            'ctx-scheme-normalize.undeclared-field',
            'ctx-scheme-process.missing-input',
            'ctx-scheme-process.undeclared-query-parameter',
            'ctx-scheme-process.undeclared-request-field-fix',
            'ctx-scheme-process.undeclared-request-field-format',
            'ctx-scheme-process.undeclared-request-field-normalization',
            'ctx-scheme-process.undeclared-request-field-preserveDeprecated',
            'ctx-scheme-process.undeclared-request-field-repairStrategy',
            'ctx-scheme-process.undeclared-request-field-scope',
            'ctx-scheme-process.undeclared-request-field-skipInference',
            'ctx-scheme-process.undeclared-request-field-skipRepair',
            'ctx-scheme-process.undeclared-request-field-tolerant',
            'ctx-scheme-process.undeclared-request-field-unknownField',
            'ctx-scheme-process.undeclared-request-field-validateOnly',
            'ctx-scheme-render.undeclared-field',
            'ctx-scheme-scan.undeclared-field',
            'ctx-scheme-suggest-for-categories.undeclared-field',
            'ctx-scheme-suggest.both-sources',
            'ctx-scheme-suggest.no-source',
            'ctx-scheme-suggest.undeclared-field',
            'ctx-scheme-validate.undeclared-field',
            'health.undeclared-query-parameter',
        ],
    },
    {
        reason: 'The route or method is one the contract does not declare, so no public method exists to reach it.',
        cases: [
            'method-guard.allow-header',
            'route-miss.ctx-operation-not-found',
            'route-miss.route-not-found',
        ],
    },
    {
        reason: 'The public call is the seven-leg profile warm, and the corpus records only this one leg without a Context carrier.',
        cases: ['denial.ctx-scheme-without-carrier'],
    },
];

/** Every operation the vendored contract declares, by operationId. */
function contractOperations(): Map<string, string> {
    const document = yaml.load(readFileSync(SPEC_PATH, 'utf8')) as {
        paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const operations = new Map<string, string>();
    for (const [path, item] of Object.entries(document.paths)) {
        for (const [method, operation] of Object.entries(item)) {
            if (!HTTP_METHODS.has(method)) continue;
            const id = operation.operationId;
            if (!id) throw new Error(`${method} ${path} has no operationId`);
            if (operations.has(id)) throw new Error(`${id} is declared twice`);
            operations.set(id, `${method.toUpperCase()} ${path}`);
        }
    }
    return operations;
}

/**
 * Wrap a client so a driver touching a private member is recorded.
 *
 * Methods are bound to the real object, so the client's own internal use of its
 * private members goes past the proxy and is not counted; only what the driver
 * itself reaches for is.
 */
function watched<T extends object>(target: T, touched: Set<string>): T {
    return new Proxy(target, {
        get(object, property) {
            if (typeof property === 'string' && property.startsWith('_')) {
                touched.add(property);
            }
            const value: unknown = Reflect.get(object, property, object);
            if (typeof value === 'function') return value.bind(object);
            if (value !== null && typeof value === 'object') {
                return watched(value, touched);
            }
            return value;
        },
    });
}

interface DriverRun {
    cases: readonly string[];
    privateMembers: string[];
}

const corpus = loadWireCorpus();
const runs = new Map<string, DriverRun>();

beforeAll(async () => {
    for (const [name, driver] of Object.entries(WIRE_DRIVERS)) {
        const transport = new ReplayTransport(
            corpus,
            driver.cases,
            driver.assertRequest,
        );
        const client = buildReplayClient(driver.binding, transport.fetch);
        const touched = new Set<string>();
        try {
            await driver.run(watched<EzClassifyClient>(client, touched));
        } catch (error) {
            // Refusals are the recorded answer for many of these; the replay
            // suite checks each outcome. Only the emitted requests matter here,
            // but anything other than a client error is the harness failing.
            if (!(error instanceof EzClassifyError)) throw error;
        } finally {
            client.destroy();
        }
        transport.assertEveryCaseEmitted();
        runs.set(name, { cases: driver.cases, privateMembers: [...touched] });
    }
});

function privatelyDriven(): string[] {
    return [...runs.values()]
        .filter((run) => run.privateMembers.length > 0)
        .flatMap((run) => [...run.cases])
        .sort();
}

describe('every contract operation has a public method', () => {
    it('sends each operation from a public call, or says why it never does', () => {
        const sentPublicly = new Set(
            [...runs.values()]
                .filter((run) => run.privateMembers.length === 0)
                .flatMap((run) => [...run.cases])
                .map((caseId) => corpus.byId.get(caseId)?.operationId),
        );
        const missing = [...contractOperations()]
            .filter(([id]) => !sentPublicly.has(id) && !(id in NOT_SENT))
            .map(([id, route]) => `${id} (${route})`);
        expect(
            missing,
            'the contract declares operations no public call sends. Add the method, ' +
                'or record in NOT_SENT why this client deliberately never sends it.',
        ).toEqual([]);
    });

    it('lists in NOT_SENT only operations the contract declares and nothing sends', () => {
        const operations = contractOperations();
        const stale = Object.keys(NOT_SENT).filter((id) => !operations.has(id));
        expect(stale).toEqual([]);
        const sent = new Set(
            [...runs.values()]
                .flatMap((run) => [...run.cases])
                .map((caseId) => corpus.byId.get(caseId)?.operationId),
        );
        expect(Object.keys(NOT_SENT).filter((id) => sent.has(id))).toEqual([]);
    });
});

describe('corpus cases driven through a private seam', () => {
    it('are exactly the listed ones', () => {
        const listed = PRIVATE_SEAM.flatMap((entry) => [...entry.cases]).sort();
        expect(
            privatelyDriven(),
            'a driver reaches a private member for a case not listed in PRIVATE_SEAM, ' +
                'or a listed case is now driven publicly. Drive it through a public ' +
                'method, or file it under the reason that covers it.',
        ).toEqual(listed);
    });

    it('reach only the request transport', () => {
        const members = new Set(
            [...runs.values()].flatMap((run) => run.privateMembers),
        );
        expect([...members]).toEqual(['_request']);
    });
});
