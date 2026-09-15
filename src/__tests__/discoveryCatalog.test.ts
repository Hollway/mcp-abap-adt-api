import { DiscoveryHandlers } from '../handlers/DiscoveryHandlers';
import { ClassHandlers } from '../handlers/ClassHandlers';
import {
    pageLoadTypes,
    pageDiscovery,
    pageCompatibilityGraph,
    discoveryTitles,
    collectionHrefs,
    nearestHrefs,
    nearestTitles
} from '../lib/discoveryCatalog';
import { pageClassComponents, classUrl } from '../lib/classShape';

/**
 * The discovery and class-shape family, measured on a classic ERP system
 * before any of this existed:
 *
 *  - loadTypes answered 141,045 characters, adtDiscovery 42,033 and
 *    adtCompatibiliyGraph 29,039, each in one unfiltered lump;
 *  - featureDetails, collectionFeatureDetails and findCollectionByUrl each
 *    answered {"status":"success"} and nothing else, for a title that exists
 *    and for one that does not alike;
 *  - classIncludes threw "clas.includes is not iterable" on every call,
 *    because the library method behind it takes a class structure and the
 *    schema promised a name;
 *  - classComponents handed back 13,501 characters of backend tree.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const typeRow = (over: any = {}) => ({
    OBJECT_TYPE: 'CLAS/OC',
    OBJECT_TYPE_LABEL: 'Classes',
    CATEGORY: 'source_library',
    CATEGORY_LABEL: 'Source Library',
    URI_TEMPLATE: '/sap/bc/adt/oo/classes/{name}',
    PARENT_OBJECT_TYPE: '',
    OBJNAME_MAXLENGTH: 30,
    CAPABILITIES: [],
    ...over
});

const workspaces = [
    {
        title: 'Object Orientation',
        collection: [
            { href: '/sap/bc/adt/oo/classes', title: 'Classes', templateLinks: [{ rel: 'a' }, { rel: 'b' }] },
            { href: '/sap/bc/adt/oo/interfaces', title: 'Interfaces', templateLinks: [] }
        ]
    },
    {
        title: 'ATC',
        collection: { href: '/sap/bc/adt/atc/runs', title: 'ATC Runs', templateLinks: [] }
    }
];

describe('the catalogues, summarized instead of poured out', () => {
    it('counts the whole catalogue and returns one page of it', () => {
        const all = [
            typeRow(),
            typeRow({ OBJECT_TYPE: 'PROG/P', OBJECT_TYPE_LABEL: 'Programs' }),
            typeRow({ OBJECT_TYPE: 'FUGR/F', OBJECT_TYPE_LABEL: 'Function Groups' })
        ];
        const page = pageLoadTypes(all, { maxResults: 2 });

        expect(page.summary.total).toBe(3);
        expect(page.summary.matched).toBe(3);
        expect(page.summary.returned).toBe(2);
        expect(page.summary.more).toBe(true);
        expect(page.types[0]).toEqual({
            type: 'CLAS/OC',
            label: 'Classes',
            category: 'Source Library',
            parent: undefined,
            uriTemplate: '/sap/bc/adt/oo/classes/{name}',
            maxNameLength: 30
        });
    });

    it('filters types by name and by category, case-insensitively', () => {
        const all = [typeRow(), typeRow({ OBJECT_TYPE: 'TABL/DT', OBJECT_TYPE_LABEL: 'Tables', CATEGORY_LABEL: 'Dictionary' })];

        expect(pageLoadTypes(all, { name: 'clas' }).summary.matched).toBe(1);
        expect(pageLoadTypes(all, { category: 'dictionary' }).types[0].type).toBe('TABL/DT');
        expect(pageLoadTypes(all, { name: 'nothing here' }).summary.matched).toBe(0);
    });

    it('flattens the discovery document and leaves the template links out', () => {
        const page = pageDiscovery(workspaces as any);

        expect(page.summary).toMatchObject({ workspaces: 2, collections: 3, templateLinks: 2 });
        expect(page.collections[0]).toEqual({
            workspace: 'Object Orientation',
            href: '/sap/bc/adt/oo/classes',
            title: 'Classes',
            templateLinkCount: 2
        });
        expect(pageDiscovery(workspaces as any, { includeTemplates: true }).collections[0].templateLinks)
            .toEqual([{ rel: 'a' }, { rel: 'b' }]);
    });

    it('searches the discovery document by address, title or workspace', () => {
        expect(pageDiscovery(workspaces as any, { search: 'atc' }).summary.matched).toBe(1);
        expect(pageDiscovery(workspaces as any, { search: 'Interfaces' }).collections[0].href)
            .toBe('/sap/bc/adt/oo/interfaces');
    });

    it('counts the compatibility graph and pages its edges', () => {
        const graph = {
            edges: [
                { sourceNode: { nameSpace: 'A', name: 'one' }, targetNode: { nameSpace: 'A', name: 'two' } },
                { sourceNode: { nameSpace: 'B', name: 'three' }, targetNode: { nameSpace: 'A', name: 'one' } }
            ]
        };
        const page = pageCompatibilityGraph(graph, { maxResults: 1 });

        expect(page.summary).toMatchObject({ edges: 2, matched: 2, returned: 1, nodes: 3, namespaces: 2 });
        expect(page.edges).toEqual([{ from: 'A/one', to: 'A/two' }]);
        expect(pageCompatibilityGraph(graph, { namespace: 'B' }).summary.matched).toBe(1);
        expect(pageCompatibilityGraph(graph, { name: 'three' }).summary.matched).toBe(1);
        expect(pageCompatibilityGraph(undefined, {}).summary.edges).toBe(0);
    });

    it('names the titles and addresses closest to one that matched nothing', () => {
        expect(discoveryTitles(workspaces as any)).toContain('Classes');
        expect(collectionHrefs(workspaces as any)).toContain('/sap/bc/adt/atc/runs');
        expect(nearestHrefs(collectionHrefs(workspaces as any), '/sap/bc/adt/oo/classe')[0])
            .toBe('/sap/bc/adt/oo/classes');
        expect(nearestTitles(['Classes', 'Interfaces'], 'class')).toEqual(['Classes']);
    });
});

describe('the lookups that used to answer with nothing', () => {
    const client = (over: any = {}) => ({
        statelessClone: {
            adtDiscovery: async () => workspaces,
            featureDetails: async () => undefined,
            collectionFeatureDetails: async () => undefined,
            findCollectionByUrl: async () => undefined,
            loadTypes: async () => [typeRow()],
            adtCoreDiscovery: async () => [],
            adtCompatibiliyGraph: async () => ({ edges: [] }),
            ...over
        }
    }) as any;

    it('says a feature title is not there, and names the nearest', async () => {
        const result = answer(await new DiscoveryHandlers(client()).handleFeatureDetails({ title: 'Classe' }));

        expect(result.found).toBe(false);
        expect(result.nearestTitles).toContain('Classes');
        expect(result.titleCount).toBe(5);
    });

    it('answers a feature that is there with found true', async () => {
        const handlers = new DiscoveryHandlers(client({ featureDetails: async () => ({ title: 'Classes' }) }));
        const result = answer(await handlers.handleFeatureDetails({ title: 'Classes' }));

        expect(result.found).toBe(true);
        expect(result.details).toEqual({ title: 'Classes' });
    });

    it('says a collection address is not a template link, which is what that lookup matches', async () => {
        const handlers = new DiscoveryHandlers(client());
        const details = answer(await handlers.handleCollectionFeatureDetails({ url: '/sap/bc/adt/oo/classes' }));

        expect(details.found).toBe(false);
        expect(details.reason).toMatch(/that address is a collection/i);
        expect(details.hint).toMatch(/findCollectionByUrl/);
    });

    it('names the template links closest to one that matched nothing', async () => {
        const handlers = new DiscoveryHandlers(client({
            adtDiscovery: async () => [{
                title: 'ATC',
                collection: [{
                    href: '/sap/bc/adt/atc/exemptions',
                    title: 'ATC exemptions',
                    templateLinks: [{ template: '/sap/bc/adt/atc/exemptions/{id}' }]
                }]
            }]
        }));
        const details = answer(await handlers.handleCollectionFeatureDetails({ url: '/sap/bc/adt/atc/exemptions/{i' }));

        expect(details.nearestTemplates).toEqual(['/sap/bc/adt/atc/exemptions/{id}']);
        expect(details.templateCount).toBe(1);
    });

    it('says an address is served by no collection, and names the nearest', async () => {
        const found = answer(await new DiscoveryHandlers(client()).handleFindCollectionByUrl({ url: '/sap/bc/adt/nope' }));

        expect(found.found).toBe(false);
        expect(found.collectionCount).toBe(3);
    });

    it('answers loadTypes with a summary rather than the catalogue', async () => {
        const result = answer(await new DiscoveryHandlers(client()).handleLoadTypes({ name: 'clas' }));

        expect(result.status).toBe('success');
        expect(result.summary.total).toBe(1);
        expect(result.filter).toEqual({ name: 'clas', category: undefined });
    });
});

describe('what a class is made of', () => {
    const structure = {
        'adtcore:name': 'CL_ONE',
        'adtcore:type': 'CLAS/OC',
        objectUrl: '/sap/bc/adt/oo/classes/cl_one',
        includes: [
            {
                'class:includeType': 'main',
                links: [{ type: 'text/plain', href: 'source/main' }]
            },
            {
                'class:includeType': 'testclasses',
                links: [{ type: 'text/plain', href: 'includes/testclasses' }]
            }
        ]
    };

    it('resolves a class name to its URL, and leaves a URL alone', () => {
        expect(classUrl('CL_ONE')).toBe('/sap/bc/adt/oo/classes/cl_one');
        expect(classUrl('/sap/bc/adt/oo/classes/cl_one/source/main')).toBe('/sap/bc/adt/oo/classes/cl_one');
    });

    it('reads the structure first, so a name is enough', async () => {
        const client: any = { statelessClone: { objectStructure: async () => structure } };
        const result = answer(await new ClassHandlers(client).handleClassIncludes({ clas: 'CL_ONE' }));

        expect(result.found).toBe(true);
        expect(result.result).toEqual({
            main: '/sap/bc/adt/oo/classes/cl_one/source/main',
            testclasses: '/sap/bc/adt/oo/classes/cl_one/includes/testclasses'
        });
        expect(result.includes[0]).toEqual({
            includeType: 'main',
            url: '/sap/bc/adt/oo/classes/cl_one/source/main'
        });
    });

    it('says so when the object has no includes at all', async () => {
        const client: any = {
            statelessClone: { objectStructure: async () => ({ 'adtcore:type': 'PROG/P' }) }
        };
        const result = answer(await new ClassHandlers(client).handleClassIncludes({ clas: 'Z_REPORT' }));

        expect(result.found).toBe(false);
        expect(result.objectType).toBe('PROG/P');
        expect(result.hint).toMatch(/mainPrograms/);
    });

    it('flattens the component tree and counts it by type and visibility', () => {
        const root = {
            'adtcore:name': 'CL_ONE',
            'adtcore:type': 'CLAS/OC',
            visibility: 'public',
            final: true,
            components: [
                {
                    'adtcore:name': 'IF_ONE',
                    'adtcore:type': 'CLAS/OR',
                    visibility: 'public',
                    components: [
                        { 'adtcore:name': 'DO_IT', 'adtcore:type': 'CLAS/OM', visibility: 'public', components: [] }
                    ]
                },
                { 'adtcore:name': 'MV_X', 'adtcore:type': 'CLAS/OA', visibility: 'private', components: [] }
            ]
        };
        const page = pageClassComponents(root as any);

        expect(page.class).toEqual({ name: 'CL_ONE', type: 'CLAS/OC', visibility: 'public', final: true });
        expect(page.summary.total).toBe(3);
        expect(page.summary.byVisibility).toEqual([
            { name: 'public', count: 2 },
            { name: 'private', count: 1 }
        ]);
        expect(page.components.find(c => c.name === 'DO_IT')?.parent).toBe('IF_ONE');
        expect(pageClassComponents(root as any, { type: 'CLAS/OM' }).summary.matched).toBe(1);
        expect(pageClassComponents(root as any, { visibility: 'private' }).components[0].name).toBe('MV_X');
    });
});
