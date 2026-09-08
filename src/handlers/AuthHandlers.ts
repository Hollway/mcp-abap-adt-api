import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import type { ToolDefinition } from '../types/tools.js';

export class AuthHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'login',
        description: 'Authenticate with the ABAP system. Use it to recover a dead session; read-only calls now recover on their own.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'logout',
        description: 'Terminate the ABAP session and clear its cookies. WARNING: this client cannot log in again afterwards - the server process has to be restarted. To just release the session use dropSession.',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'dropSession',
        description: 'Clear the local session cache (releases held locks server-side; the next call logs on again).',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'login':
        return this.handleLogin(args);
      case 'logout':
        return this.handleLogout(args);
      case 'dropSession':
        return this.handleDropSession(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown auth tool: ${toolName}`);
    }
  }

  private async handleLogin(args: any) {
    const startTime = performance.now();
    try {
      await this.adtclient.login();
      this.trackRequest(startTime, true);
      // ADTClient.login() resolves to undefined, and JSON.stringify(undefined)
      // is undefined too - which used to leave the tool result without any
      // text and made the client reject the response schema even though the
      // re-authentication had succeeded.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'success',
              loggedin: this.adtclient.loggedin,
              user: this.adtclient.username,
              url: this.adtclient.baseUrl,
              client: this.adtclient.client || undefined,
              language: this.adtclient.language || undefined
            })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Login failed');
    }
  }

  private async handleLogout(args: any) {
    const startTime = performance.now();
    try {
      await this.adtclient.logout();
      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ status: 'success', loggedin: this.adtclient.loggedin, note: 'This client cannot log in again; restart the server process to reconnect.' })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Logout failed');
    }
  }

  private async handleDropSession(args: any) {
    const startTime = performance.now();
    try {
      await this.adtclient.dropSession();
      this.trackRequest(startTime, true);
      return {
        content: [
          {
            type: 'text', 
            text: JSON.stringify({ status: 'success', loggedin: this.adtclient.loggedin, note: 'Session dropped; server-side locks are released and the next call logs on again.' })
          }
        ]
      };
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Drop session failed');
    }
  }
}
