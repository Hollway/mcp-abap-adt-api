import { AdtErrorException } from 'abap-adt-api';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { AtcHandlers } from '../handlers/AtcHandlers';
import { CodeAnalysisHandlers } from '../handlers/CodeAnalysisHandlers';
import { DdicHandlers } from '../handlers/DdicHandlers';
import { GitHandlers } from '../handlers/GitHandlers';
import { NodeHandlers } from '../handlers/NodeHandlers';
import { ObjectHandlers } from '../handlers/ObjectHandlers';
import { TransportHandlers } from '../handlers/TransportHandlers';
import { htmlToText, documentText } from '../lib/htmlText';
import { requireShape, missingFields } from '../lib/argShape';
import { fixProposalRows } from '../lib/quickFixes';
import { isVariantNameSafe, variantNames, judgeVariant } from '../lib/atcVariants';

/**
 * The second half of the tools no smoke run had ever called, and what a live
 * run on a classic ERP system found in them:
 *
 *  - syntaxCheckTypes answered {} on every system it ever ran on, because the
 *    library hands back a Map and JSON.stringify writes a Map as {};
 *  - objectTypes and ddicRepositoryAccess answered an empty list as a
 *    successful retrieval;
 *  - syntaxCheckCdsUrl answered a view that does not exist with no messages,
 *    which is exactly what a clean check looks like;
 *  - packageSearchHelp declared its type as a free string, and all four of the
 *    real values answer 404 on this release anyway;
 *  - transportsByConfig with an address no configuration has answered with
 *    every request in the system - 327,499 characters;
 *  - checkRepo, renamePreview, fixEdits and bindingDetails each ended in
 *    "Cannot read properties of undefined";
 *  - abapDocumentation and atcDocumentation answered with whole HTML pages;
 *  - atcCheckVariant answered an invented variant name with a worklist id, a
 *    different one on every call.
 */
const answer = (result: any) => JSON.parse(result.content[0].text);

const adtError = (status: number, message: string) =>
    new AdtErrorException(status, {}, 'ExceptionResourceNotFound', message, undefined, 'com.sap.adt', message);

describe('answers that were empty by construction', () => {
    it('writes the syntax check types as an object, not as an empty Map', async () => {
        const client: any = {
            statelessClone: {
                syntaxCheckTypes: async () => new Map([['abapCheckRun', ['ABAP']], ['cdsCheckRun', ['DDLS']]])
            }
        };
        const result = answer(await new CodeAnalysisHandlers(client).handleSyntaxCheckTypes({}));

        expect(result.checkTypes).toBe(2);
        expect(result.result).toEqual({ abapCheckRun: ['ABAP'], cdsCheckRun: ['DDLS'] });
    });

    it('says the object-type catalogue is empty rather than retrieved', async () => {
        const client: any = { statelessClone: { objectTypes: async () => [] } };
        const result = answer(await new ObjectHandlers(client).handleObjectTypes({}));

        expect(result.found).toBe(false);
        expect(result.hint).toMatch(/loadTypes/);
    });

    it('says the dictionary knows nothing under a name', async () => {
        const client: any = { statelessClone: { ddicRepositoryAccess: async () => [] } };
        const result = answer(await new DdicHandlers(client).handleDdicRepositoryAccess({ path: 'NO_SUCH' }));

        expect(result.found).toBe(false);
        expect(result.hint).toMatch(/takes a name, not an address/);
    });

    it('does not call a CDS view that is not there clean', async () => {
        const client: any = {
            statelessClone: {
                objectStructure: async () => { throw adtError(404, 'not found'); },
                syntaxCheck: async () => []
            }
        };
        const result = answer(await new CodeAnalysisHandlers(client)
            .handleSyntaxCheckCdsUrl({ cdsUrl: '/sap/bc/adt/ddic/ddl/sources/no_such' }));

        expect(result.found).toBe(false);
        expect(result.clean).toBeUndefined();
    });

    it('calls a CDS view that is there clean when it has no messages', async () => {
        const client: any = {
            statelessClone: {
                objectStructure: async () => ({ 'adtcore:name': 'I_ONE' }),
                syntaxCheck: async () => []
            }
        };
        const result = answer(await new CodeAnalysisHandlers(client)
            .handleSyntaxCheckCdsUrl({ cdsUrl: '/sap/bc/adt/ddic/ddl/sources/i_one' }));

        expect(result).toMatchObject({ found: true, clean: true, objectName: 'I_ONE' });
    });
});

describe('documentation, as text rather than as a page', () => {
    const page = '<!doctype HTML><html><head><link rel="icon" href="x"><style>b {}</style></head>' +
        '<body><p>First line</p><p>Second &amp; last</p></body></html>';

    it('keeps the text and the paragraph breaks, drops the rest', () => {
        expect(htmlToText(page)).toBe('First line\nSecond & last');
        expect(htmlToText('')).toBe('');
        expect(htmlToText('plain words')).toBe('plain words');
    });

    it('measures both sizes, and keeps the page only when asked', () => {
        const trimmed = documentText(page);
        expect(trimmed.chars).toBeLessThan(trimmed.htmlChars);
        expect(trimmed.html).toBeUndefined();
        expect(documentText(page, true).html).toBe(page);
    });

    it('answers abapDocumentation with the text', async () => {
        const client: any = { statelessClone: { abapDocumentation: async () => page } };
        const result = answer(await new CodeAnalysisHandlers(client)
            .handleAbapDocumentation({ objectUri: '/x', body: 'DATA x.', line: 1, column: 1 }));

        expect(result.found).toBe(true);
        expect(result.text).toBe('First line\nSecond & last');
        expect(result.htmlChars).toBe(page.length);
    });
});

describe('quick fixes, readable and round-tripped', () => {
    const proposal = {
        'adtcore:name': "Rename 'cl_one'",
        'adtcore:type': 'rename_refactoring',
        'adtcore:description': '&lt;p&gt;Starts the rename wizard for &lt;b&gt;cl_one&lt;/b&gt;.&lt;/p&gt;',
        'adtcore:uri': '/sap/bc/adt/quickfixes/proposals/providers/refactoring/quickfixes/qf_command_rename',
        uri: '/sap/bc/adt/oo/classes/cl_one/source/main',
        line: 1,
        column: 7,
        userContent: ''
    };

    it('decodes the description and keeps what fixEdits needs', () => {
        const [row] = fixProposalRows([proposal]);

        expect(row.description).toBe('Starts the rename wizard for cl_one.');
        expect(row['adtcore:uri']).toBe(proposal['adtcore:uri']);
        expect(row.line).toBe(1);
    });

    it('refuses a proposal that is not one, naming what is missing', () => {
        const client: any = { statelessClone: { fixEdits: async () => [] } };
        const handlers = new CodeAnalysisHandlers(client);

        return expect(handlers.handleFixEdits({ proposal: {}, source: 'REPORT z.' }))
            .rejects.toThrow(/fixProposals/);
    });

    it('lets a proposal straight from fixProposals through', async () => {
        const client: any = { statelessClone: { fixEdits: async () => [{ uri: '/x' }] } };
        const result = answer(await new CodeAnalysisHandlers(client)
            .handleFixEdits({ proposal, source: 'REPORT z.' }));

        expect(result.status).toBe('success');
    });
});

describe('object-shaped parameters, checked before they are dereferenced', () => {
    it('names the fields that are missing', () => {
        expect(missingFields(undefined, ['links'])).toEqual(['links']);
        expect(missingFields({ links: [] }, ['links'])).toEqual([]);
        expect(missingFields('a string', ['links'])).toEqual(['links']);
    });

    it('says where the object comes from', () => {
        expect(() => requireShape(undefined, { parameter: 'repo', fields: ['links'], producedBy: 'gitRepos' }))
            .toThrow(/nothing was passed/);
        expect(() => requireShape('ZREPO', { parameter: 'repo', fields: ['links'], producedBy: 'gitRepos' }))
            .toThrow(/a string was passed/);
        expect(() => requireShape({}, { parameter: 'repo', fields: ['links'], producedBy: 'gitRepos' }))
            .toThrow(/these fields are missing: links/);
    });

    it('refuses a repository that is only a name', async () => {
        const handlers = new GitHandlers({ statelessClone: { checkRepo: async () => ({}) } } as any);

        await expect(handlers.handleCheckRepo({ repo: 'ZREPO' })).rejects.toThrow(McpError);
    });

    it('reports a system without abapGit as such, not as a failed call', async () => {
        const missing = adtError(404, 'Resource  /sap/bc/adt/abapgit/externalrepoinfo does not exist.');
        const handlers = new GitHandlers({
            statelessClone: { gitExternalRepoInfo: async () => { throw missing; } }
        } as any);

        await expect(handlers.handleGitExternalRepoInfo({ repourl: 'https://example.invalid/r.git' }))
            .rejects.toThrow(/abapGit is not installed/);
    });
});

describe('answers about something else', () => {
    it('refuses a configuration address the system does not publish', async () => {
        const client: any = {
            statelessClone: {
                transportConfigurations: async () => [{ link: '/sap/bc/adt/cts/.../configurations/AAA' }],
                transportsByConfig: async () => ({ workbench: [], customizing: [] })
            }
        };

        await expect(new TransportHandlers(client)
            .handleTransportsByConfig({ configUri: '/sap/bc/adt/cts/.../configurations/NOPE' }))
            .rejects.toThrow(/every transport request in the system/);
    });

    it('says so when the system publishes no configurations at all', async () => {
        const client: any = {
            statelessClone: {
                transportConfigurations: async () => [],
                transportsByConfig: async () => ({ workbench: [], customizing: [] })
            }
        };

        await expect(new TransportHandlers(client).handleTransportsByConfig({ configUri: '/whatever' }))
            .rejects.toThrow(/publishes no transport organizer configurations/);
    });

    it('flattens the requests of a configuration it accepts', async () => {
        const link = '/sap/bc/adt/cts/.../configurations/AAA';
        const client: any = {
            statelessClone: {
                transportConfigurations: async () => [{ link }],
                transportsByConfig: async () => ({
                    workbench: [{
                        'tm:name': 'DEV',
                        modifiable: [{ 'tm:number': 'DEVK900001', 'tm:owner': 'TESTER', 'tm:desc': 'one', 'tm:status': 'D', tasks: [] }],
                        released: []
                    }],
                    customizing: []
                })
            }
        };
        const result = answer(await new TransportHandlers(client).handleTransportsByConfig({ configUri: link }));

        expect(result.count).toBe(1);
        expect(result.requests[0]).toMatchObject({ number: 'DEVK900001', status: 'D', category: 'workbench' });
    });

    it('says which includes have main programs when the backend only says 404', async () => {
        const client: any = {
            statelessClone: { mainPrograms: async () => { throw adtError(404, 'not found'); } }
        };

        await expect(new NodeHandlers(client)
            .handleMainPrograms({ includeUrl: '/sap/bc/adt/oo/classes/cl_one/includes/implementations' }))
            .rejects.toThrow(/classIncludes/);
    });
});

describe('the package value help, and the four names it takes', () => {
    it('refuses anything outside the four', async () => {
        const handlers = new DdicHandlers({ statelessClone: { packageSearchHelp: async () => [] } } as any);

        await expect(handlers.handlePackageSearchHelp({ type: 'PACKAGE' }))
            .rejects.toThrow(/applicationcomponents, softwarecomponents, transportlayers, translationrelevances/);
    });

    it('reports a release without the endpoint as such', async () => {
        const handlers = new DdicHandlers({
            statelessClone: { packageSearchHelp: async () => { throw adtError(404, 'not found'); } }
        } as any);

        await expect(handlers.handlePackageSearchHelp({ type: 'transportlayers' }))
            .rejects.toThrow(/does not serve the package value helps/);
    });
});

describe('ATC check variants, confirmed before a worklist is opened', () => {
    const rows = [
        { CHECKVNAME: 'DEFAULT', CIUSER: '' },
        { CHECKVNAME: 'MY_OWN', CIUSER: 'TESTER' }
    ];

    it('accepts only what an ATC name may contain', () => {
        expect(isVariantNameSafe('DEFAULT')).toBe(true);
        expect(isVariantNameSafe('/SDF/CCLM_METRICS')).toBe(true);
        expect(isVariantNameSafe('')).toBe(false);
        expect(isVariantNameSafe('DEFAULT&checkVariant=OTHER')).toBe(false);
    });

    it('reads the variants and tells the global ones apart', () => {
        const names = variantNames({ values: rows });
        expect(names).toEqual([{ name: 'DEFAULT', global: true }, { name: 'MY_OWN', global: false }]);
        expect(judgeVariant('default', names)).toMatchObject({ checked: true, exists: true });
        expect(judgeVariant('NOPE', names)).toMatchObject({ checked: true, exists: false, examples: ['DEFAULT'] });
        expect(judgeVariant('DEFAULT', [])).toEqual({ checked: false });
    });

    it('refuses a variant the system does not have', async () => {
        const client: any = {
            statelessClone: {
                runQuery: async () => ({ values: rows }),
                atcCheckVariant: async () => 'SHOULD-NOT-BE-CALLED'
            }
        };

        await expect(new AtcHandlers(client).handleAtcCheckVariant({ variant: 'NOPE' }))
            .rejects.toThrow(/no ATC check variant called/);
    });

    it('opens a worklist for one it does have, and says the name was verified', async () => {
        const client: any = {
            statelessClone: {
                runQuery: async () => ({ values: rows }),
                atcCheckVariant: async () => 'WORKLIST-1'
            }
        };
        const result = answer(await new AtcHandlers(client).handleAtcCheckVariant({ variant: 'DEFAULT' }));

        expect(result).toMatchObject({ worklistId: 'WORKLIST-1', variantVerified: true });
    });

    it('goes ahead when the variant table cannot be read at all', async () => {
        const client: any = {
            statelessClone: {
                runQuery: async () => { throw adtError(403, 'no'); },
                atcCheckVariant: async () => 'WORKLIST-2'
            }
        };
        const result = answer(await new AtcHandlers(client).handleAtcCheckVariant({ variant: 'ANYTHING' }));

        expect(result).toMatchObject({ worklistId: 'WORKLIST-2', variantVerified: false });
    });
});
