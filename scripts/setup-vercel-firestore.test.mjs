import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS as s, expected, inspect, setup } from './setup-vercel-firestore.mjs';
const number = '123456789012';
const e = expected(number);
const marker = 'Managed by catan-3d setup-vercel-firestore.mjs v1.';
const permissions = [
  'datastore.databases.get',
  'datastore.entities.create',
  'datastore.entities.delete',
  'datastore.entities.get',
  'datastore.entities.list',
  'datastore.entities.update',
];
function fixture(existing = false) {
  const state = {
    apis: [
      'firestore.googleapis.com',
      'iam.googleapis.com',
      'iamcredentials.googleapis.com',
      'sts.googleapis.com',
    ],
    pools: existing ? [{ name: e.pool, state: 'ACTIVE', description: marker }] : [],
    providers: existing
      ? [
          {
            name: e.provider,
            state: 'ACTIVE',
            description: marker,
            oidc: { issuerUri: e.issuer, allowedAudiences: [] },
            attributeMapping: { 'google.subject': 'assertion.sub' },
            attributeCondition: e.trust,
          },
        ]
      : [],
    accounts: existing ? [{ email: e.account, projectId: s.projectId, description: marker }] : [],
    roles: existing ? [{ name: e.role }] : [],
    role: { name: e.role, stage: 'GA', description: marker, includedPermissions: permissions },
    keys: [],
    accountPolicy: {
      bindings: existing
        ? [{ role: 'roles/iam.workloadIdentityUser', members: [e.principal] }]
        : [],
    },
    projectPolicy: {
      bindings: existing
        ? [{ role: e.role, members: [`serviceAccount:${e.account}`], condition: e.condition }]
        : [],
    },
    calls: [],
  };
  const runner = (args) => {
    state.calls.push(args);
    const starts = (text) => args.slice(0, text.split(' ').length).join(' ') === text;
    if (starts('projects describe'))
      return { projectId: s.projectId, projectNumber: number, lifecycleState: 'ACTIVE' };
    if (starts('services list')) return state.apis.map((name) => ({ config: { name } }));
    if (starts('firestore databases describe'))
      return {
        name: `projects/${s.projectId}/databases/${s.databaseId}`,
        type: 'FIRESTORE_NATIVE',
      };
    if (starts('iam workload-identity-pools list')) return state.pools;
    if (starts('iam workload-identity-pools providers list')) return state.providers;
    if (starts('iam service-accounts list')) return state.accounts;
    if (starts('iam service-accounts keys list')) return state.keys;
    if (starts('iam service-accounts get-iam-policy')) return state.accountPolicy;
    if (starts('iam roles list')) return state.roles;
    if (starts('iam roles describe')) return state.role;
    if (starts('projects get-iam-policy')) return state.projectPolicy;
    if (starts('services enable')) {
      state.apis = fixture(true).state.apis;
      return {};
    }
    if (starts('iam workload-identity-pools create')) {
      state.pools = fixture(true).state.pools;
      return {};
    }
    if (starts('iam workload-identity-pools providers create-oidc')) {
      state.providers = fixture(true).state.providers;
      return {};
    }
    if (starts('iam service-accounts create')) {
      state.accounts = fixture(true).state.accounts;
      return {};
    }
    if (starts('iam roles create')) {
      state.roles = fixture(true).state.roles;
      return {};
    }
    if (starts('iam service-accounts add-iam-policy-binding')) {
      state.accountPolicy = fixture(true).state.accountPolicy;
      return {};
    }
    if (starts('projects add-iam-policy-binding')) {
      state.projectPolicy = fixture(true).state.projectPolicy;
      return {};
    }
    throw Error(`Unexpected command ${args.join(' ')}`);
  };
  return { state, runner };
}
const mutates = (calls) =>
  calls.filter((args) =>
    args.some((value) =>
      [
        'create',
        'create-oidc',
        'enable',
        'add-iam-policy-binding',
        'delete',
        'update',
        'set-iam-policy',
      ].includes(value),
    ),
  );
test('default review reads existing resources and never executes planned writes', () => {
  const { state, runner } = fixture();
  const result = setup({ runner, log() {} });
  assert.equal(result.commands.length, 6);
  assert.equal(mutates(state.calls).length, 0);
  const provider = result.commands.find((command) => command.includes('create-oidc'));
  assert(provider.includes(`--attribute-condition=${e.trust}`));
  assert.equal(
    provider.some((arg) => arg.startsWith('--allowed-audiences=')),
    false,
  );
  assert(e.trust.includes(s.teamId) && e.trust.includes(s.vercelProjectId));
  const binding = result.commands.at(-1);
  assert(
    binding.some((arg) =>
      arg.includes("resource.name == 'projects/inventory-management-6626b/databases/(default)'"),
    ),
  );
});
test('review with disabled APIs prints only an enable plan without enabling anything', () => {
  const { state, runner } = fixture();
  state.apis = [];
  const result = setup({ runner, log() {} });
  assert.equal(result.complete, false);
  assert.equal(result.commands.length, 1);
  assert.equal(mutates(state.calls).length, 0);
});
test('apply creates only missing resources then verifies convergence; repeat apply is a no-op', () => {
  const { state, runner } = fixture();
  setup({ apply: true, runner, log() {} });
  assert.equal(mutates(state.calls).length, 6);
  state.calls = [];
  setup({ apply: true, runner, log() {} });
  assert.equal(mutates(state.calls).length, 0);
});
test('existing exact configuration needs no new bindings', () => {
  const { runner } = fixture(true);
  assert.deepEqual(inspect(runner, number), []);
});
for (const [name, change] of [
  [
    'foreign pool',
    (state) => {
      state.pools[0].description = 'someone else';
    },
  ],
  [
    'disabled pool',
    (state) => {
      state.pools[0].disabled = true;
    },
  ],
  [
    'another provider',
    (state) => {
      state.providers.push({ name: `${e.pool}/providers/other` });
    },
  ],
  [
    'loose provider condition',
    (state) => {
      state.providers[0].attributeCondition = 'true';
    },
  ],
  [
    'other issuer',
    (state) => {
      state.providers[0].oidc.issuerUri = 'https://oidc.vercel.com';
    },
  ],
  [
    'broader audiences',
    (state) => {
      state.providers[0].oidc.allowedAudiences = ['https://vercel.com/anyone'];
    },
  ],
  [
    'foreign account',
    (state) => {
      state.accounts[0].description = 'existing unrelated identity';
    },
  ],
  [
    'private key',
    (state) => {
      state.keys.push({ name: 'existing-key' });
    },
  ],
  [
    'other impersonator',
    (state) => {
      state.accountPolicy.bindings[0].members.push('user:other@example.com');
    },
  ],
  [
    'broad custom role',
    (state) => {
      state.role.includedPermissions = [...permissions, 'datastore.databases.delete'];
    },
  ],
  [
    'unscoped permission',
    (state) => {
      delete state.projectPolicy.bindings[0].condition;
    },
  ],
  [
    'another role',
    (state) => {
      state.projectPolicy.bindings.push({
        role: 'roles/editor',
        members: [`serviceAccount:${e.account}`],
      });
    },
  ],
])
  test(`fails closed on ${name} before changing trust or permissions`, () => {
    const { state, runner } = fixture(true);
    change(state);
    assert.throws(() => setup({ apply: true, runner, log() {} }));
    assert.equal(mutates(state.calls).length, 0);
  });
