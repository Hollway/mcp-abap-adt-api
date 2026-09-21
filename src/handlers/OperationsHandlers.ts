import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { BaseHandler } from './BaseHandler.js';
import { wrapAdtError } from '../lib/adtError';
import { rowsOf } from '../lib/transportHygiene';
import type { ToolDefinition } from '../types/tools.js';
import {
  OperationsQueryError,
  jobQuery,
  stepQuery,
  describeJob,
  describeStep,
  spoolQuery,
  describeSpool,
  logQuery,
  logCountQueries,
  describeLog,
  messageCounts,
  JOB_STATUS
} from '../lib/operations';

/**
 * What an operator looks at, for a session that has no SAPGUI.
 *
 * SM37, SP01 and SLG1 have no ADT endpoint, but their tables do, and the data
 * preview reads a table without running anything - so these work on a system
 * where nothing may be executed, and need no developer key. See lib/operations
 * for the queries and for what cannot be read this way.
 */
export class OperationsHandlers extends BaseHandler {
  getTools(): ToolDefinition[] {
    return [
      {
        name: 'backgroundJobs',
        description: 'Background jobs and what became of them - the list SM37 shows. Answers the name, the run, who scheduled it and who it runs as, when it started and ended, and the status in words. With withSteps it also reads each job\'s steps: the program, its variant, and the spool request it produced. Reading only, and it executes nothing, so it works on a system where nothing may run.',
        inputSchema: {
          type: 'object',
          properties: {
            jobName: {
              type: 'string',
              description: 'Job name, e.g. ZAPP_NIGHTLY. A trailing * makes it a prefix.'
            },
            user: {
              type: 'string',
              description: 'The user the job RUNS AS (TBTCO-AUTHCKNAM), which is not always who scheduled it.'
            },
            scheduledBy: {
              type: 'string',
              description: 'Who scheduled the job (TBTCO-SDLUNAME).'
            },
            status: {
              type: 'string',
              description: `One of: ${Object.values(JOB_STATUS).join(', ')}. The letter the table holds is accepted too.`
            },
            since: {
              type: 'string',
              description: 'Only jobs started on this day or later, as YYYYMMDD or YYYY-MM-DD. A job that never started has no start date and is left out by this filter.'
            },
            withSteps: {
              type: 'boolean',
              description: 'Read the steps of each job returned - one query per job, so it is off by default.'
            },
            maxResults: {
              type: 'number',
              description: 'Jobs to return, default 50.'
            }
          }
        }
      },
      {
        name: 'spoolRequests',
        description: 'Spool requests - the list SP01 shows: who owns each one, when it was created, which device it is for, its title and whether it is complete. Creation times are UTC, which is how TSP01 records them, while a job start time from backgroundJobs is the local time of the system - on a system ahead of UTC the spool a job produced reads older than the job. Reading only, and it executes nothing. The CONTENT of a request is not here: it lives in the TemSe store, which no SELECT reaches.',
        inputSchema: {
          type: 'object',
          properties: {
            owner: {
              type: 'string',
              description: 'The user who owns the request. A trailing * makes it a prefix.'
            },
            destination: {
              type: 'string',
              description: 'Output device, e.g. LOCL.'
            },
            since: {
              type: 'string',
              description: 'Only requests created on this day or later, as YYYYMMDD or YYYY-MM-DD. Compared against the UTC stamp TSP01 holds.'
            },
            maxResults: {
              type: 'number',
              description: 'Requests to return, default 50.'
            }
          }
        }
      },
      {
        name: 'applicationLog',
        description: 'Application log headers - what SLG1 lists: the log object and subobject, the external id, who wrote it, which program, and how many messages of each severity it holds. Reading only, and it executes nothing. The TEXT of the messages is not here and cannot be: BALDAT stores them as a compressed cluster rather than as rows, so only the counts are readable by SELECT.',
        inputSchema: {
          type: 'object',
          properties: {
            object: {
              type: 'string',
              description: 'Log object, e.g. MMPUR. A trailing * makes it a prefix.'
            },
            subObject: {
              type: 'string',
              description: 'Log subobject.'
            },
            user: {
              type: 'string',
              description: 'The user who wrote the log.'
            },
            since: {
              type: 'string',
              description: 'Only logs written on this day or later, as YYYYMMDD or YYYY-MM-DD.'
            },
            withCounts: {
              type: 'boolean',
              description: 'Read the message counts per severity for the logs returned. Default true; it costs one more query per 20 logs.'
            },
            maxResults: {
              type: 'number',
              description: 'Logs to return, default 50.'
            }
          }
        }
      }
    ];
  }

  async handle(toolName: string, args: any): Promise<any> {
    switch (toolName) {
      case 'backgroundJobs':
        return this.handleBackgroundJobs(args);
      case 'spoolRequests':
        return this.handleSpoolRequests(args);
      case 'applicationLog':
        return this.handleApplicationLog(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown operations tool: ${toolName}`);
    }
  }

  private limit(args: any, fallback = 50): number {
    const asked = Number(args?.maxResults);
    return Number.isFinite(asked) && asked > 0 ? Math.trunc(asked) : fallback;
  }

  /** Build the statement, turning a bad filter into a refusal rather than a query. */
  private build(make: () => string): string {
    try {
      return make();
    } catch (error: any) {
      if (error instanceof OperationsQueryError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
  }

  private async rows(sql: string, limit: number): Promise<Record<string, any>[]> {
    return rowsOf(await this.readClient.runQuery(sql, limit));
  }

  async handleBackgroundJobs(args: any): Promise<any> {
    const limit = this.limit(args);
    const sql = this.build(() => jobQuery({
      jobName: args?.jobName,
      user: args?.user,
      scheduledBy: args?.scheduledBy,
      status: args?.status,
      since: args?.since
    }));

    const startTime = performance.now();
    try {
      const jobs = (await this.rows(sql, limit)).map(describeJob);
      this.trackRequest(startTime, true);

      if (args?.withSteps === true) {
        for (const job of jobs) {
          const stepSql = this.build(() => stepQuery(job.name, job.count));
          job.steps = (await this.rows(stepSql, 100)).map(describeStep);
        }
      }

      return this.answer({
        status: 'success',
        found: jobs.length,
        ...(jobs.length === limit
          ? { truncated: true, hint: `Showing the first ${limit} jobs the filter matched; raise maxResults or narrow it.` }
          : {}),
        jobs,
        query: sql,
        ...(jobs.length === 0
          ? { note: 'No job matched. A job that has never run has no start date, so a since filter leaves it out; drop it to see scheduled jobs.' }
          : {})
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to read the background jobs');
    }
  }

  async handleSpoolRequests(args: any): Promise<any> {
    const limit = this.limit(args);
    const sql = this.build(() => spoolQuery({
      owner: args?.owner,
      destination: args?.destination,
      since: args?.since
    }));

    const startTime = performance.now();
    try {
      const requests = (await this.rows(sql, limit)).map(describeSpool);
      this.trackRequest(startTime, true);
      return this.answer({
        status: 'success',
        found: requests.length,
        ...(requests.length === limit
          ? { truncated: true, hint: `Showing the first ${limit} requests; raise maxResults or narrow the filter.` }
          : {}),
        requests,
        query: sql,
        note: 'Times are UTC, as TSP01 records them - a job start time is local, so the two do not line up on a system away from UTC. The content of a request is in the TemSe store, which no SELECT reaches: this is the list, not the printout.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to read the spool requests');
    }
  }

  async handleApplicationLog(args: any): Promise<any> {
    const limit = this.limit(args);
    const sql = this.build(() => logQuery({
      object: args?.object,
      subObject: args?.subObject,
      user: args?.user,
      since: args?.since
    }));

    const startTime = performance.now();
    try {
      const logs = (await this.rows(sql, limit)).map(describeLog);
      this.trackRequest(startTime, true);

      if (args?.withCounts !== false && logs.length) {
        const counts = new Map<string, ReturnType<typeof messageCounts>>();
        for (const query of logCountQueries(logs.map(log => log.logNumber))) {
          for (const row of await this.rows(query, logs.length)) {
            counts.set(String(row.LOGNUMBER ?? ''), messageCounts(row));
          }
        }
        for (const log of logs) {
          const found = counts.get(log.logNumber);
          if (found) log.messages = found;
        }
      }

      return this.answer({
        status: 'success',
        found: logs.length,
        ...(logs.length === limit
          ? { truncated: true, hint: `Showing the first ${limit} logs; raise maxResults or narrow the filter.` }
          : {}),
        logs,
        query: sql,
        note: 'These are the headers. The message texts live in BALDAT as a compressed cluster, which a SELECT cannot read - the counts here are what the header records.'
      });
    } catch (error: any) {
      this.trackRequest(startTime, false);
      throw wrapAdtError(error, 'Failed to read the application log');
    }
  }
}
