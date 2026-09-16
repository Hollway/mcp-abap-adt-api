import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError, isSessionFailure, describeAdtError } from '../lib/adtError';
import { lockRegistry } from '../lib/lockRegistry';
import { sourceCache } from '../lib/sourceCache';
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
        description: 'End the stateful session and forget what died with it: the locks this server recorded and the sources it cached. Releases server-side locks; the next call logs on again. With no session open it is a local cleanup and says so.',
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

  /**
   * Drop the stateful session, and forget what died with it.
   *
   * Two things were wrong here. The library's dropSession sends its request
   * without the auto-login the normal path has (AdtHTTP.dropSession calls
   * _request directly), so on a client that never logged in - the usual case,
   * because every read runs on the stateless clone - the call came back 401
   * and the tool reported failure for a session that did not exist.
   *
   * And dropping the session invalidates every lock handle taken in it, while
   * the registry went on offering them to the next write. Whatever happens on
   * the wire, the local bookkeeping is cleared: that is what the tool promises.
   */
  private async handleDropSession(args: any) {
    const startTime = performance.now();
    const locks = lockRegistry.count();
    const sources = sourceCache.count();
    const hadSession = this.adtclient.loggedin;
    let dropped = false;
    let note = 'No session was open; nothing to drop on the system.';

    try {
      if (hadSession) {
        await this.adtclient.dropSession();
        dropped = true;
        note = 'Session dropped; server-side locks are released and the next call logs on again.';
      }
    } catch (error: any) {
      // A session that cannot be dropped because it is already gone is the
      // state this tool exists to reach - and an unauthenticated answer is
      // exactly what a dead session gives, whatever the credentials are worth.
      // Anything else is a real failure.
      const status = describeAdtError(error).status;
      if (status !== 401 && !isSessionFailure(error)) {
        this.trackRequest(startTime, false);
        throw wrapAdtError(error, 'Drop session failed');
      }
      note = 'The session was already gone on the system; local state cleared anyway.';
    } finally {
      lockRegistry.clear();
      sourceCache.clear();
    }

    this.trackRequest(startTime, true);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            dropped,
            loggedin: this.adtclient.loggedin,
            locksForgotten: locks,
            sourcesForgotten: sources,
            note
          })
        }
      ]
    };
  }
}
