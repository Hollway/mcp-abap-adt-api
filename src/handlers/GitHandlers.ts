import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, isMissingCollection } from '../lib/adtError';
import { requireShape } from '../lib/argShape';
import type { ToolDefinition } from '../types/tools.js';
import { GitRepo, GitStaging } from 'abap-adt-api';

/** What the abapGit calls dereference on the repository they are handed. */
const REPO_LINKS_SHAPE = {
    parameter: 'repo',
    fields: ['links'],
    producedBy: 'gitRepos'
};

export class GitHandlers extends BaseHandler {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'gitRepos',
                description: 'The abapGit repositories linked on this system, with their packages, branches and state.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'gitExternalRepoInfo',
                description: 'Whether an external git repository can be reached with these credentials, and which branches it offers - the check before linking it.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repourl: {
                            type: 'string',
                            description: 'The URL of the repository.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repourl']
                }
            },
            {
                name: 'gitCreateRepo',
                description: 'Link a package to an abapGit repository and pull it. This WRITES the objects of that repository into the package - the largest write in this server.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        packageName: {
                            type: 'string',
                            description: 'The name of the package.'
                        },
                        repourl: {
                            type: 'string',
                            description: 'The URL of the repository.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['packageName', 'repourl']
                }
            },
            {
                name: 'gitPullRepo',
                description: 'Pull an abapGit repository into its package. This WRITES every object the repository carries, overwriting what is there, and needs a transport outside $TMP.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repoId: {
                            type: 'string',
                            description: 'The ID of the repository.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repoId']
                }
            },
            {
                name: 'gitUnlinkRepo',
                description: 'Disconnect a package from its abapGit repository. The objects stay; the link and its state go, and reconnecting means setting it up again.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repoId: {
                            type: 'string',
                            description: 'The ID of the repository.'
                        }
                    },
                    required: ['repoId']
                }
            },
            {
                name: 'stageRepo',
                description: 'Stage the local changes of an abapGit repository for a commit: which objects would go, with their state.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The repository row gitRepos answered with, passed back unchanged - the call reads its links.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'pushRepo',
                description: 'Push staged changes of an abapGit repository to the remote. Outward-facing: it writes to the git remote under the credentials configured there.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The repository row gitRepos answered with, passed back unchanged - the call reads its links.'
                        },
                        staging: {
                            type: 'object',
                            description: 'The staging object stageRepo answered with, passed back unchanged.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repo', 'staging']
                }
            },
            {
                name: 'checkRepo',
                description: 'Check an abapGit repository before pulling: what would change, and whether anything local stands in the way.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The repository row gitRepos answered with, passed back unchanged - the call reads its links and its url, so a name or a key alone is not enough.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'remoteRepoInfo',
                description: 'What a remote abapGit repository holds: its branches and their heads, read with the credentials passed in.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The repository row gitRepos answered with, passed back unchanged - the call reads its links and its url, so a name or a key alone is not enough.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'switchRepoBranch',
                description: 'Switch an abapGit repository to another branch. It changes what the next pull would write, and a pull after it can rewrite the whole package.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The repository row gitRepos answered with, passed back unchanged - the call reads its links and its url, so a name or a key alone is not enough.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.'
                        },
                        create: {
                            type: 'boolean',
                            description: 'Whether to create the branch if it doesn\'t exist.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.'
                        },
                        password: {
                            type: 'string',
                            description: 'The password.'
                        }
                    },
                    required: ['repo', 'branch']
                }
            }
        ];
    }

    async handle(toolName: string, args: any): Promise<any> {
        switch (toolName) {
            case 'gitRepos':
                return this.handleGitRepos(args);
            case 'gitExternalRepoInfo':
                return this.handleGitExternalRepoInfo(args);
            case 'gitCreateRepo':
                return this.handleGitCreateRepo(args);
            case 'gitPullRepo':
                return this.handleGitPullRepo(args);
            case 'gitUnlinkRepo':
                return this.handleGitUnlinkRepo(args);
            case 'stageRepo':
                return this.handleStageRepo(args);
            case 'pushRepo':
                return this.handlePushRepo(args);
            case 'checkRepo':
                return this.handleCheckRepo(args);
            case 'remoteRepoInfo':
                return this.handleRemoteRepoInfo(args);
            case 'switchRepoBranch':
                return this.handleSwitchRepoBranch(args);
            default:
                throw new McpError(ErrorCode.MethodNotFound, `Unknown git tool: ${toolName}`);
        }
    }

    /**
     * abapGit is a plugin, not a part of ADT: on a system without it every one
     * of these calls answers 404 "Resource /sap/bc/adt/abapgit/... does not
     * exist". Passed on as it comes, that reads as a fault of the call rather
     * than as a system that has no abapGit at all.
     */
    private gitError(error: unknown, label: string) {
        return wrapAdtError(error, isMissingCollection(error)
            ? 'abapGit is not installed on this system: the /sap/bc/adt/abapgit collection is absent, so no repository call can be served'
            : label);
    }

    async handleGitRepos(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const repos = await this.readClient.gitRepos();
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            repos
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw wrapAdtError(error, isMissingCollection(error)
                ? 'abapGit is not installed on this system: the /sap/bc/adt/abapgit collection is absent, which is not the same as having no repositories'
                : 'Failed to get git repos');
        }
    }

    async handleGitExternalRepoInfo(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const repoInfo = await this.readClient.gitExternalRepoInfo(
                args.repourl,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            repoInfo
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to get external repo info');
        }
    }

    async handleGitCreateRepo(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.gitCreateRepo(
                args.packageName,
                args.repourl,
                args.branch,
                args.transport,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to create git repo');
        }
    }

    async handleGitPullRepo(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.gitPullRepo(
                args.repoId,
                args.branch,
                args.transport,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to pull git repo');
        }
    }

    async handleGitUnlinkRepo(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.gitUnlinkRepo(args.repoId);
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to unlink git repo');
        }
    }

    async handleStageRepo(args: any): Promise<any> {
        const startTime = performance.now();
        requireShape(args?.repo, REPO_LINKS_SHAPE);
        try {
            const result = await this.adtclient.stageRepo(
                args.repo,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to stage repo');
        }
    }

    async handlePushRepo(args: any): Promise<any> {
        const startTime = performance.now();
        requireShape(args?.repo, REPO_LINKS_SHAPE);
        try {
            const result = await this.adtclient.pushRepo(
                args.repo,
                args.staging,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to push repo');
        }
    }

    async handleCheckRepo(args: any): Promise<any> {
        const startTime = performance.now();
        requireShape(args?.repo, REPO_LINKS_SHAPE);
        try {
            const result = await this.readClient.checkRepo(
                args.repo,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to check repo');
        }
    }

    async handleRemoteRepoInfo(args: any): Promise<any> {
        const startTime = performance.now();
        requireShape(args?.repo, {
            parameter: 'repo',
            fields: ['url'],
            producedBy: 'gitRepos'
        });
        try {
            const repoInfo = await this.readClient.remoteRepoInfo(
                args.repo,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            repoInfo
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to get remote repo info');
        }
    }

    async handleSwitchRepoBranch(args: any): Promise<any> {
        const startTime = performance.now();
        try {
            const result = await this.adtclient.switchRepoBranch(
                args.repo,
                args.branch,
                args.create,
                args.user,
                args.password
            );
            this.trackRequest(startTime, true);
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            status: 'success',
                            result
                        })
                    }
                ]
            };
        } catch (error: any) {
            this.trackRequest(startTime, false);
            throw this.gitError(error, 'Failed to switch repo branch');
        }
    }
}
