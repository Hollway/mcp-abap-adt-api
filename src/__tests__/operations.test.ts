import {
  abapDate,
  abapTime,
  stamp,
  namePattern,
  nameCondition,
  statement,
  jobStatusLetter,
  jobQuery,
  describeJob,
  stepQuery,
  describeStep,
  spoolQuery,
  spoolTime,
  describeSpool,
  logQuery,
  logCountQueries,
  describeLog,
  messageCounts,
  OperationsQueryError
} from '../lib/operations';
import { MAX_QUERY_CHARS } from '../lib/queryLimits';

/**
 * SM37, SP01 and SLG1 have no ADT endpoint; their tables do, and the data
 * preview reads a table without executing anything. Two things it does not
 * forgive: a SELECT over 255 characters, and a filter value that reaches the
 * statement as syntax rather than as a value.
 *
 * Measured live on ECC: a job's start time arrives as six digits and its
 * date as an ISO string at UTC midnight, while TSP01 holds the spool stamp as
 * sixteen digits in UTC - a spool produced by a job three hours ahead of UTC
 * read three hours older than the job that made it.
 */
describe('reading the dates and times the preview sends', () => {
  it('takes a date written either way', () => {
    expect(abapDate('20260916')).toBe('20260916');
    expect(abapDate('2026-09-16')).toBe('20260916');
  });

  it('refuses anything that is not a date, rather than filtering on nonsense', () => {
    expect(() => abapDate('yesterday')).toThrow(OperationsQueryError);
    expect(() => abapDate('2026-09')).toThrow(/YYYYMMDD/);
  });

  it('is absent for an absent filter', () => {
    expect(abapDate(undefined)).toBeUndefined();
    expect(abapDate('')).toBeUndefined();
  });

  it('reads a time out of the six digits the table holds', () => {
    expect(abapTime('095656')).toBe('09:56:56');
    expect(abapTime('170757')).toBe('17:07:57');
  });

  it('joins the date and the time of one row', () => {
    expect(stamp('2026-09-16T00:00:00.000Z', '170757')).toBe('2026-09-16 17:07:57');
  });

  it('leaves a row with no date without a stamp - a job that never ran has none', () => {
    expect(stamp('', '000000')).toBeUndefined();
    expect(stamp(undefined, undefined)).toBeUndefined();
  });

  it('reads the sixteen-digit spool stamp', () => {
    expect(spoolTime('2026091614075700')).toBe('2026-09-16 14:07:57');
    expect(spoolTime('short')).toBeUndefined();
  });
});

describe('what may go into a WHERE clause', () => {
  it('takes a name, and a trailing star as the prefix it looks like', () => {
    expect(namePattern('ZAPP_NIGHTLY', 'job name')).toEqual({ sql: 'ZAPP_NIGHTLY', like: false });
    expect(namePattern('z*', 'job name')).toEqual({ sql: 'Z%', like: true });
  });

  it('refuses a value that would reach the statement as syntax', () => {
    expect(() => namePattern("X' OR '1'='1", 'job name')).toThrow(OperationsQueryError);
    expect(() => namePattern('a b', 'job name')).toThrow(/letters, digits/);
  });

  it('writes an equality for a name and a LIKE for a prefix', () => {
    expect(nameCondition('jobname', 'ZAPP', 'job name')).toBe("jobname = 'ZAPP'");
    expect(nameCondition('jobname', 'ZAPP*', 'job name')).toBe("jobname LIKE 'ZAPP%'");
  });

  it('refuses a statement the endpoint would refuse, and says how long it is', () => {
    const long = 'Z'.repeat(39);
    expect(() => statement(
      'SELECT jobname, jobcount, status, sdluname, authcknam, strtdate, strttime, enddate, endtime FROM tbtco',
      [nameCondition('jobname', long, 'job name'), nameCondition('authcknam', long, 'user name'), nameCondition('sdluname', long, 'user name')],
      'strtdate DESCENDING, strttime DESCENDING'
    )).toThrow(new RegExp(`${MAX_QUERY_CHARS}`));
  });
});

describe('background jobs', () => {
  it('takes a status in words or as the letter the table holds', () => {
    expect(jobStatusLetter('finished')).toBe('F');
    expect(jobStatusLetter('F')).toBe('F');
    expect(jobStatusLetter('running')).toBe('R');
  });

  it('refuses a status that is neither, and lists what it takes', () => {
    expect(() => jobStatusLetter('kaput')).toThrow(/scheduled, released, ready, running, finished, cancelled/);
  });

  it('builds a query that fits, newest first', () => {
    const sql = jobQuery({ jobName: 'Z*', status: 'finished', since: '2026-01-01' });
    expect(sql).toContain("jobname LIKE 'Z%'");
    expect(sql).toContain("status = 'F'");
    expect(sql).toContain("strtdate >= '20260101'");
    expect(sql).toContain('ORDER BY strtdate DESCENDING');
    expect(sql.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it('separates who scheduled a job from who it runs as', () => {
    expect(jobQuery({ user: 'JSMITH' })).toContain("authcknam = 'JSMITH'");
    expect(jobQuery({ scheduledBy: 'JSMITH' })).toContain("sdluname = 'JSMITH'");
  });

  it('says what a status letter means, rather than leaving the letter alone', () => {
    const job = describeJob({
      JOBNAME: 'ZAPP_NIGHTLY', JOBCOUNT: '17065700', STATUS: 'F',
      SDLUNAME: 'JSMITH', AUTHCKNAM: 'BATCHUSER',
      STRTDATE: '2026-09-16T00:00:00.000Z', STRTTIME: '170757',
      ENDDATE: '2026-09-16T00:00:00.000Z', ENDTIME: '170801'
    });
    expect(job).toEqual({
      name: 'ZAPP_NIGHTLY',
      count: '17065700',
      status: 'F',
      statusMeaning: 'finished',
      scheduledBy: 'JSMITH',
      runsAs: 'BATCHUSER',
      started: '2026-09-16 17:07:57',
      ended: '2026-09-16 17:08:01'
    });
  });

  it('leaves out the times a job that never ran does not have', () => {
    const job = describeJob({ JOBNAME: 'ZAPP_LATER', JOBCOUNT: '1', STATUS: 'P' });
    expect(job.statusMeaning).toBe('scheduled');
    expect(job).not.toHaveProperty('started');
    expect(job).not.toHaveProperty('ended');
  });

  it('reads the steps of one run, and names the spool one produced', () => {
    expect(stepQuery('ZAPP_NIGHTLY', '17065700')).toContain("jobcount = '17065700'");
    expect(describeStep({ STEPCOUNT: 1, PROGNAME: 'RSPROCESS', VARIANT: '&0000000002772', AUTHCKNAM: 'BATCHUSER', LISTIDENT: '10810' }))
      .toEqual({ step: 1, program: 'RSPROCESS', variant: '&0000000002772', runsAs: 'BATCHUSER', spoolRequest: '10810' });
  });

  it('does not report a spool request for a step that produced none', () => {
    expect(describeStep({ STEPCOUNT: 2, PROGNAME: 'RSPROCESS', LISTIDENT: '0' })).not.toHaveProperty('spoolRequest');
  });
});

describe('spool requests', () => {
  it('compares a day against the sixteen-digit stamp, not against a date', () => {
    expect(spoolQuery({ since: '2026-09-16' })).toContain("rqcretime >= '2026091600000000'");
  });

  it('names the creation time for what it is: UTC', () => {
    const row = describeSpool({
      RQIDENT: 10810, RQOWNER: 'SAP_BATCH', RQCLIENT: '102',
      RQCRETIME: '2026091614075700', RQDEST: 'LP21', RQFINAL: ' ', RQDOCTYPE: 'LIST'
    });
    expect(row).toMatchObject({
      id: '10810', owner: 'SAP_BATCH', createdUtc: '2026-09-16 14:07:57', destination: 'LP21', complete: false
    });
    expect(row).not.toHaveProperty('created');
  });

  it('reports a finished request as complete', () => {
    expect(describeSpool({ RQIDENT: 1, RQOWNER: 'X', RQFINAL: 'X' }).complete).toBe(true);
  });
});

describe('application log', () => {
  it('filters on the object and the day', () => {
    const sql = logQuery({ object: 'MM*', since: '20260101' });
    expect(sql).toContain("object LIKE 'MM%'");
    expect(sql).toContain("aldate >= '20260101'");
    expect(sql.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
  });

  it('reads the counts in as many statements as the limit forces', () => {
    const numbers = Array.from({ length: 40 }, (_, i) => String(i).padStart(20, '0'));
    const queries = logCountQueries(numbers);
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) expect(query.length).toBeLessThanOrEqual(MAX_QUERY_CHARS);
    const asked = queries.join(' ');
    for (const number of numbers) expect(asked).toContain(number);
  });

  it('asks nothing when there is nothing to ask about', () => {
    expect(logCountQueries([])).toEqual([]);
  });

  it('shapes a header row', () => {
    expect(describeLog({
      LOGNUMBER: '00000000000015532403', OBJECT: 'WF', SUBOBJECT: 'WIERRE',
      ALDATE: '2026-09-16T00:00:00.000Z', ALTIME: '170057', ALUSER: 'WF-BATCH', ALPROG: 'RSWWERRE'
    })).toEqual({
      logNumber: '00000000000015532403',
      object: 'WF',
      subObject: 'WIERRE',
      written: '2026-09-16 17:00:57',
      user: 'WF-BATCH',
      program: 'RSWWERRE'
    });
  });

  it('adds up the severities the header counts', () => {
    expect(messageCounts({ MSG_CNT_A: 0, MSG_CNT_E: 2, MSG_CNT_W: 1, MSG_CNT_I: 0, MSG_CNT_S: 1 }))
      .toEqual({ abort: 0, error: 2, warning: 1, info: 0, success: 1, total: 4 });
  });

  it('counts an absent column as none rather than as NaN', () => {
    expect(messageCounts({}).total).toBe(0);
  });
});
