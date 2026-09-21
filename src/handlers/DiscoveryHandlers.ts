import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import {
    pageLoadTypes,
    pageDiscovery,
    pageCompatibilityGraph,
    discoveryTitles,
    collectionHrefs,
    templateLinks,
    nearestTitles,
    nearestHrefs
} from '../lib/discoveryCatalog';
import type { ToolDefinition } from '../types/tools.js';

export class DiscoveryHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'featureDetails',
                description: 'What one discovery feature offers, by title - the capabilities behind a collection. A title that is not in the discovery document is answered with found false and the titles closest to it, not with an empty success.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: 'The title of the feature, exactly as the discovery document spells it, e.g. Classes.'
                        }
                    },
                    required: ['title']
                }
            },
            {
                name: 'collectionFeatureDetails',
                description: 'What the collection behind a TEMPLATE LINK offers: its capabilities, its supported types and its versions. It matches template links, not collection addresses - /sap/bc/adt/oo/classes, a collection that plainly exists, is found by nothing here, and that is now said rather than answered with an empty success. For a collection address use findCollectionByUrl.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'A template link, as adtDiscovery lists them with includeTemplates: true.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'findCollectionByUrl',
                description: 'Which discovery collection serves a given URL - the reverse lookup of adtDiscovery, for when an address is in hand and its capabilities are not. An address served by nothing is answered with found false and the nearest collections.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The address to resolve, e.g. /sap/bc/adt/oo/classes.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'loadTypes',
                description: 'The object types the creation endpoints accept, with the templates behind them - what a wrong objtype is checked against. The whole catalogue is some 1,500 types and 141,000 characters on a classic ERP system, so the answer is a summary plus one filtered page.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        name: {
                            type: 'string',
                            description: 'Substring of the type id or its label, case-insensitive, e.g. CLAS or class.'
                        },
                        category: {
                            type: 'string',
                            description: 'Substring of the category id or label, e.g. source_library.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Types to return, default 50.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Types to skip before the page, default 0.'
                        }
                    }
                }
            },
            {
                name: 'adtDiscovery',
                description: 'The ADT service document: every collection this system offers, with its URL and the object types it serves. This is where the address of an unfamiliar collection comes from. The whole document runs to some 42,000 characters, most of it template links, so the answer is a summary plus one filtered page and the links are left out unless asked for.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        search: {
                            type: 'string',
                            description: 'Substring of a collection address, its title or its workspace, e.g. atc or classes.'
                        },
                        includeTemplates: {
                            type: 'boolean',
                            description: 'Include the template links of each collection. Off by default - they are the bulk of the document.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Collections to return, default 60.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Collections to skip before the page, default 0.'
                        }
                    }
                }
            },
            {
                name: 'adtCoreDiscovery',
                description: 'The core discovery document of the ADT service - what healthcheck calls to prove the connection is alive.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtCompatibiliyGraph',
                description: 'The ADT compatibility graph of this system: which protocol versions its collections speak. Diagnostic, for a call refused as an unsupported version. The graph runs to some 29,000 characters, so the answer is a summary plus one filtered page of edges.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        namespace: {
                            type: 'string',
                            description: 'Substring of a namespace on either end of an edge, e.g. COM.SAP.ADT.ABAPUNIT.'
                        },
                        name: {
                            type: 'string',
                            description: 'Substring of a node name on either end of an edge.'
                        },
                        maxResults: {
                            type: 'number',
                            description: 'Edges to return, default 50.'
                        },
                        offset: {
                            type: 'number',
                            description: 'Edges to skip before the page, default 0.'
                        }
                    }
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'featureDetails':
                return this.handleFeatureDetails(args);
            case 'collectionFeatureDetails':
                return this.handleCollectionFeatureDetails(args);
            case 'findCollectionByUrl':
                return this.handleFindCollectionByUrl(args);
            case 'loadTypes':
                return this.handleLoadTypes(args);
            case 'adtDiscovery':
                return this.handleAdtDiscovery(args);
            case 'adtCoreDiscovery':
                return this.handleAdtCoreDiscovery(args);
            case 'adtCompatibiliyGraph':
                return this.handleAdtCompatibilityGraph(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown discovery tool: ${toolName}`);
        }
    }

    private json(payload: unknown) {
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }

    async handleFeatureDetails(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const details = await this.readClient.featureDetails(args.title);
            this.trackRequest(startTime, true);
            if (!details) {
                const titles = discoveryTitles((await this.readClient.adtDiscovery()) as any);
                return this.json({
                    status: 'success',
                    found: false,
                    title: args.title,
                    reason: 'No feature of the discovery document carries this title.',
                    nearestTitles: nearestTitles(titles, args.title),
                    titleCount: titles.length,
                    hint: 'Titles come from adtDiscovery - search it for the collection first.'
                });
            }
            return this.json({ status: 'success', found: true, title: args.title, details });
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get feature details');
        }
    }

    async handleCollectionFeatureDetails(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const details = await this.readClient.collectionFeatureDetails(args.url);
            this.trackRequest(startTime, true);
            if (!details) {
                // This lookup matches template links, not collection
                // addresses: /sap/bc/adt/oo/classes, a collection that plainly
                // exists, finds nothing here.
                const discovery = (await this.readClient.adtDiscovery()) as any;
                const templates = templateLinks(discovery);
                const isCollection = collectionHrefs(discovery).includes(String(args.url));
                return this.json({
                    status: 'success',
                    found: false,
                    url: args.url,
                    reason: isCollection
                        ? 'That address is a collection, and this lookup matches the template links inside collections - no template of this system is published at it.'
                        : 'No template link of the discovery document is published at this address.',
                    nearestTemplates: nearestHrefs(templates, args.url),
                    templateCount: templates.length,
                    hint: isCollection
                        ? 'For what a collection itself offers use findCollectionByUrl; template links are listed by adtDiscovery with includeTemplates: true.'
                        : 'Template links come from adtDiscovery with includeTemplates: true.'
                });
            }
            return this.json({ status: 'success', found: true, url: args.url, details });
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to get collection feature details');
        }
    }

    async handleFindCollectionByUrl(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const collection = await this.readClient.findCollectionByUrl(args.url);
            this.trackRequest(startTime, true);
            if (!collection) {
                const hrefs = collectionHrefs((await this.readClient.adtDiscovery()) as any);
                return this.json({
                    status: 'success',
                    found: false,
                    url: args.url,
                    reason: 'No collection of the discovery document serves this address.',
                    nearestCollections: nearestHrefs(hrefs, args.url),
                    collectionCount: hrefs.length
                });
            }
            return this.json({ status: 'success', found: true, url: args.url, collection });
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, 'Failed to find collection by URL');
        }
    }

    async handleLoadTypes(args: any): Promise<any> {
        return this.tracked('Failed to load types', async () => {
            const types = await this.readClient.loadTypes();
            return this.json({
                status: 'success',
                ...pageLoadTypes(types as any, {
                    name: args?.name,
                    category: args?.category,
                    maxResults: args?.maxResults,
                    offset: args?.offset
                })
            });
        });
    }

    async handleAdtDiscovery(args: any): Promise<any> {
        return this.tracked('Failed to perform ADT discovery', async () => {
            const discovery = await this.readClient.adtDiscovery();
            return this.json({
                status: 'success',
                ...pageDiscovery(discovery as any, {
                    search: args?.search,
                    includeTemplates: args?.includeTemplates,
                    maxResults: args?.maxResults,
                    offset: args?.offset
                })
            });
        });
    }

    async handleAdtCoreDiscovery(args: any): Promise<any> {
        return this.tracked('Failed to perform ADT core discovery', async () => {
            const discovery = await this.readClient.adtCoreDiscovery();
            return this.json({ status: 'success', discovery });
        });
    }

    async handleAdtCompatibilityGraph(args: any): Promise<any> {
        return this.tracked('Failed to get ADT compatibility graph', async () => {
            const graph = await this.readClient.adtCompatibiliyGraph();
            return this.json({
                status: 'success',
                ...pageCompatibilityGraph(graph as any, {
                    namespace: args?.namespace,
                    name: args?.name,
                    maxResults: args?.maxResults,
                    offset: args?.offset
                })
            });
        });
    }
}
