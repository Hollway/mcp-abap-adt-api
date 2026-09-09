import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';
import { GitRepo, GitStaging } from 'abap-adt-api';

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
                            description: 'The Git repository object.'
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
                            description: 'The Git repository object.'
                        },
                        staging: {
                            type: 'object',
                            description: 'The staging information object.'
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
                            type: 'string',
                            description: 'The Git repository.'
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
                            type: 'string',
                            description: 'The Git repository.'
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
                            type: 'string',
                            description: 'The Git repository.'
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
            throw wrapAdtError(error, 'Failed to get git repos');
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
            throw wrapAdtError(error, 'Failed to get external repo info');
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
            throw wrapAdtError(error, 'Failed to create git repo');
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
            throw wrapAdtError(error, 'Failed to pull git repo');
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
            throw wrapAdtError(error, 'Failed to unlink git repo');
        }
    }

    async handleStageRepo(args: any): Promise<any> {
        const startTime = performance.now();
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
            throw wrapAdtError(error, 'Failed to stage repo');
        }
    }

    async handlePushRepo(args: any): Promise<any> {
        const startTime = performance.now();
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
            throw wrapAdtError(error, 'Failed to push repo');
        }
    }

    async handleCheckRepo(args: any): Promise<any> {
        const startTime = performance.now();
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
            throw wrapAdtError(error, 'Failed to check repo');
        }
    }

    async handleRemoteRepoInfo(args: any): Promise<any> {
        const startTime = performance.now();
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
            throw wrapAdtError(error, 'Failed to get remote repo info');
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
            throw wrapAdtError(error, 'Failed to switch repo branch');
        }
    }
}
