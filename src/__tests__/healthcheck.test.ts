import { AbapAdtServer } from '../index';
import { serverVersion } from '../lib/serverConfig';

/**
 * Which build answered is a question a client can otherwise only ask once, on
 * initialize, and the answer is not kept anywhere it can be read again. With
 * several servers sharing one compiled directory, "is this the process that
 * picked up the last build" was answered by trying a tool and watching how it
 * behaved - so healthcheck says it outright, in both of its answers: the one
 * where ADT replies and the one where it does not.
 */
const clientThat = (discovery: () => Promise<any>): any => ({
  baseUrl: 'https://example.invalid',
  client: '100',
  language: 'EN',
  username: 'TESTER',
  loggedin: true,
  isStateful: true,
  csrfToken: 'token',
  adtCoreDiscovery: discovery
});

const healthcheckOf = (discovery: () => Promise<any>): Promise<any> => {
  const server = new AbapAdtServer(clientThat(discovery)) as any;
  return server.healthcheck();
};

const isoLike = (value: string) => expect(new Date(value).toISOString()).toBe(value);

describe('healthcheck says which build is answering', () => {
  it('names the version, the build time and the process start when ADT answers', async () => {
    const payload = await healthcheckOf(async () => [{ }, { }]);
    expect(payload.status).toBe('healthy');
    expect(payload.server.version).toBe(serverVersion());
    isoLike(payload.server.built);
    isoLike(payload.server.startedAt);
  });

  it('says it even when ADT does not answer, which is when it is most needed', async () => {
    const payload = await healthcheckOf(async () => { throw new Error('no route to host'); });
    expect(payload.status).toBe('unhealthy');
    expect(payload.server.version).toBe(serverVersion());
    isoLike(payload.server.built);
    isoLike(payload.server.startedAt);
  });

  it('reports the version the package carries, not a literal of its own', async () => {
    const packaged = require('../../package.json').version;
    const payload = await healthcheckOf(async () => []);
    expect(payload.server.version).toBe(packaged);
  });
});
