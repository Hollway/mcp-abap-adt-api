import { fullParse, extractXmlArray, typedNodeAttr } from 'abap-adt-api/build/utilities';

/**
 * The trace list, parsed here rather than by the library.
 *
 * abap-adt-api decodes the atom feed of /runtime/traces/abaptraces through an
 * io-ts codec that declares `title` mandatory. SAP only writes <atom:title> for
 * a trace that was given a description, so on a system with any undescribed
 * trace - which is most of them - the whole call fails after the backend has
 * already answered correctly. The data is fine; only the codec is wrong.
 *
 * Everything else about the shape is kept as the library reports it, so a
 * caller that already reads `runs[].extendedData` sees no difference. Dates
 * stay the ISO strings the backend sends: the library turned them into Date
 * objects, which JSON.stringify writes back out as the same strings anyway.
 */

export interface TraceFeedLink {
    href: string;
    rel: string;
    type?: string;
    title?: string;
}

export interface TraceFeedRun {
    id: string;
    title: string;
    author: string;
    authorUri?: string;
    published?: string;
    updated?: string;
    type?: string;
    src?: string;
    lang?: string;
    extendedData: Record<string, any>;
    links?: TraceFeedLink[];
}

export interface TraceFeed {
    total: number;
    returned: number;
    runs: TraceFeedRun[];
}

export interface TraceFeedOptions {
    /** Cap on the runs reported. The count is always for everything found. */
    limit?: number;
    /** Keep the four atom links per run. They are half the answer's size. */
    includeLinks?: boolean;
}

const asString = (x: unknown): string | undefined =>
    x === undefined || x === null ? undefined : String(x);

const parseRun = (entry: any, includeLinks: boolean): TraceFeedRun => {
    const extendedData: Record<string, any> = { ...(entry?.extendedData ?? {}) };
    delete extendedData['#text'];
    if (extendedData.state) extendedData.state = typedNodeAttr(extendedData.state);

    const run: TraceFeedRun = {
        id: String(entry?.id ?? ''),
        // The whole point of parsing this ourselves: a trace with no
        // description carries no title, and that is not an error.
        title: asString(entry?.title) ?? '',
        author: String(entry?.author?.name ?? ''),
        authorUri: asString(entry?.author?.uri),
        published: asString(entry?.published),
        updated: asString(entry?.updated),
        type: asString(entry?.content?.['@_type']),
        src: asString(entry?.content?.['@_src']),
        lang: asString(entry?.['@_lang']),
        extendedData
    };

    if (includeLinks) {
        run.links = extractXmlArray<any>(entry?.link).map(link => ({
            href: String(link?.['@_href'] ?? ''),
            rel: String(link?.['@_rel'] ?? ''),
            type: asString(link?.['@_type']),
            title: asString(link?.['@_title'])
        }));
    }

    return run;
};

export const parseTraceFeed = (xml: string, options: TraceFeedOptions = {}): TraceFeed => {
    const raw = fullParse(xml, { removeNSPrefix: true });
    const entries = extractXmlArray<any>(raw?.feed?.entry);
    const runs = entries.map(entry => parseRun(entry, options.includeLinks === true));
    const limit = options.limit;
    const capped = limit !== undefined && limit >= 0 ? runs.slice(0, limit) : runs;
    return { total: runs.length, returned: capped.length, runs: capped };
};

/**
 * What the backend insists on when a trace configuration is created.
 *
 * Two of its fields are only accepted in one exact shape, and anything else
 * comes back as a flat 400 "Data is invalid and could not be converted" that
 * names neither field:
 *
 * - `parametersId` has to be the full URI tracesSetParameters answered with.
 *   The bare id out of that URI is rejected.
 * - `expires` has to be a full ISO-8601 timestamp with milliseconds. A plain
 *   date, or a timestamp without milliseconds, is rejected.
 *
 * Both are normalised here rather than left to the caller to guess.
 */
export const normaliseTraceConfig = <T extends Record<string, any>>(config: T): T => {
    const normalised: Record<string, any> = { ...config };

    const parametersId = normalised.parametersId;
    if (typeof parametersId === 'string' && parametersId && !parametersId.startsWith('/')) {
        normalised.parametersId = `/sap/bc/adt/runtime/traces/abaptraces/parameters/${parametersId}`;
    }

    const expires = normalised.expires;
    if (expires !== undefined && expires !== null && expires !== '') {
        const asDate = expires instanceof Date ? expires : new Date(String(expires));
        if (Number.isNaN(asDate.getTime())) {
            throw new Error(
                `expires is not a date: '${String(expires)}'. Give it as an ISO-8601 timestamp, e.g. 2026-12-31T00:00:00.000Z.`
            );
        }
        normalised.expires = asDate.toISOString();
    }

    return normalised as T;
};
