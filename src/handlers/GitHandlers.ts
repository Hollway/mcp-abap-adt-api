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
                description: 'Retrieves a list of Git repositories.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'gitExternalRepoInfo',
                description: 'Retrieves information about an external Git repository.',
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
                description: 'Creates a new Git repository.',
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
                description: 'Pulls changes from a Git repository.',
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
                description: 'Unlinks a Git repository.',
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
                description: 'Stages changes in a Git repository.',
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
                description: 'Pushes changes to a Git repository.',
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
                description: 'Checks a Git repository.',
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
                description: 'Retrieves information about a remote Git repository.',
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
                description: 'Switches the branch of a Git repository.',
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
