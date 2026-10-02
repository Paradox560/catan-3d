#!/usr/bin/env node
// Review-only by default. --apply adds the narrowly scoped resources described below.
// Does not create keys, modify Firestore data/rules, or update an existing trust resource.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SETTINGS = Object.freeze({
  projectId: 'inventory-management-6626b',
  databaseId: '(default)',
  poolId: 'catan-vercel',
  providerId: 'vercel',
  serviceAccountId: 'catan-api',
  roleId: 'catanFirestoreData',
  teamSlug: 'pranavs-projects-e233eba1',
  teamId: 'team_6tgOPsjhyKG1HjzT5IAPmuht',
  projectName: 'catan-3d',
  vercelProjectId: 'prj_hacrrJpcDQ3DbuTAGh3bXWLIoYid',
  environment: 'production',
});
const MARKER = 'Managed by catan-3d setup-vercel-firestore.mjs v1.';
const APIS = [
  'firestore.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
];
const PERMISSIONS = [
  'datastore.databases.get',
  'datastore.entities.create',
  'datastore.entities.delete',
  'datastore.entities.get',
  'datastore.entities.list',
  'datastore.entities.update',
];
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const display = (args) => `gcloud ${args.map(quote).join(' ')}`;
function demand(condition, message) {
  if (!condition) throw new Error(message);
}
function equalList(left = [], right = []) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function sameCondition(actual, expected) {
  return (
    actual?.title === expected.title &&
    actual?.expression === expected.expression &&
    (actual?.description ?? '') === expected.description
  );
}
export function expected(projectNumber) {
  demand(/^\d{6,20}$/.test(String(projectNumber)), 'Google returned an invalid project number.');
  const s = SETTINGS;
  const account = `${s.serviceAccountId}@${s.projectId}.iam.gserviceaccount.com`;
  const pool = `projects/${projectNumber}/locations/global/workloadIdentityPools/${s.poolId}`;
  const subject = `owner:${s.teamSlug}:project:${s.projectName}:environment:${s.environment}`;
  const trust = [
    `assertion.owner_id == '${s.teamId}'`,
    `assertion.project_id == '${s.vercelProjectId}'`,
    `assertion.owner == '${s.teamSlug}'`,
    `assertion.project == '${s.projectName}'`,
    `assertion.environment == '${s.environment}'`,
    `assertion.sub == '${subject}'`,
  ].join(' && ');
  return {
    account,
    pool,
    subject,
    trust,
    provider: `${pool}/providers/${s.providerId}`,
    issuer: `https://oidc.vercel.com/${s.teamSlug}`,
    principal: `principal://iam.googleapis.com/${pool}/subject/${subject}`,
    role: `projects/${s.projectId}/roles/${s.roleId}`,
    condition: {
      title: 'catan-default-database',
      description: 'Catan data operations in the existing default Firestore database.',
      expression: `resource.name == 'projects/${s.projectId}/databases/${s.databaseId}'`,
    },
  };
}
/** The runner accepts argument arrays: no shell interpolation or credential printing. */
export function gcloud(args) {
  const result = spawnSync('gcloud', [...args, '--quiet', '--format=json'], {
    encoding: 'utf8',
    env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error)
    throw new Error(
      'Install the Google Cloud CLI and run gcloud auth login before reviewing this setup.',
    );
  if (result.status !== 0)
    throw new Error(`Google Cloud command failed: ${display(args)}\n${result.stderr.trim()}`);
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    throw new Error(
      'Google Cloud returned a response that was not valid JSON. No subsequent setup step was run.',
    );
  }
}
function read(runner, args) {
  return runner([...args, `--project=${SETTINGS.projectId}`]);
}

/** Read every existing trust/role/binding before planning mutations; mismatches fail closed. */
export function inspect(runner, projectNumber) {
  const s = SETTINGS,
    e = expected(projectNumber);
  const database = read(runner, [
    'firestore',
    'databases',
    'describe',
    `--database=${s.databaseId}`,
  ]);
  demand(
    database.name === `projects/${s.projectId}/databases/${s.databaseId}` &&
      database.type === 'FIRESTORE_NATIVE',
    'The existing default database must be Firestore Native. The script never creates or replaces a database.',
  );
  const pools = read(runner, [
    'iam',
    'workload-identity-pools',
    'list',
    '--location=global',
    '--show-deleted',
  ]);
  demand(Array.isArray(pools), 'Could not inspect existing workload identity pools.');
  const pool = pools.find((value) => value.name === e.pool);
  if (pool)
    demand(
      pool.state === 'ACTIVE' && !pool.disabled && pool.description === MARKER,
      'catan-vercel already exists with unexpected ownership/state. Review it manually; no trust resource will be updated.',
    );
  let provider;
  if (pool) {
    const providers = read(runner, [
      'iam',
      'workload-identity-pools',
      'providers',
      'list',
      `--workload-identity-pool=${s.poolId}`,
      '--location=global',
      '--show-deleted',
    ]);
    demand(Array.isArray(providers), 'Could not inspect existing identity providers.');
    demand(
      providers.every((value) => value.name === e.provider),
      'The dedicated catan-vercel pool contains another provider. Refusing to share this trust pool.',
    );
    provider = providers[0];
    if (provider)
      demand(
        provider.state === 'ACTIVE' &&
          !provider.disabled &&
          provider.description === MARKER &&
          provider.oidc?.issuerUri === e.issuer &&
          equalList(provider.oidc?.allowedAudiences ?? [], []) &&
          provider.attributeCondition === e.trust &&
          JSON.stringify(provider.attributeMapping) ===
            JSON.stringify({ 'google.subject': 'assertion.sub' }),
        'The existing Vercel provider differs from the reviewed issuer, audience, mapping, or exact production claims. No provider update will be performed.',
      );
  }
  const accounts = read(runner, ['iam', 'service-accounts', 'list']);
  demand(Array.isArray(accounts), 'Could not inspect existing service accounts.');
  const account = accounts.find((value) => value.email === e.account);
  let accountPolicy = { bindings: [] };
  if (account) {
    demand(
      account.projectId === s.projectId && !account.disabled && account.description === MARKER,
      'catan-api already exists with unexpected ownership/state. Review it manually before continuing.',
    );
    const keys = read(runner, [
      'iam',
      'service-accounts',
      'keys',
      'list',
      `--iam-account=${e.account}`,
      '--managed-by=user',
    ]);
    demand(
      Array.isArray(keys) && keys.length === 0,
      'catan-api has a user-managed private key. This setup requires a keyless dedicated identity and will not delete existing keys.',
    );
    accountPolicy = read(runner, ['iam', 'service-accounts', 'get-iam-policy', e.account]);
    demand(
      (accountPolicy.bindings ?? []).every(
        (binding) =>
          binding.role === 'roles/iam.workloadIdentityUser' &&
          !binding.condition &&
          equalList(binding.members, [e.principal]),
      ),
      'catan-api has additional or different impersonation bindings. Review them manually; existing access is not changed.',
    );
  }
  const roles = read(runner, ['iam', 'roles', 'list', '--show-deleted']);
  demand(Array.isArray(roles), 'Could not inspect existing custom roles.');
  const role = roles.find((value) => value.name === e.role);
  if (role) {
    const complete = read(runner, ['iam', 'roles', 'describe', s.roleId]);
    demand(
      !complete.deleted &&
        complete.stage === 'GA' &&
        complete.description === MARKER &&
        equalList(complete.includedPermissions, PERMISSIONS),
      'The catanFirestoreData role already exists with different permissions or ownership. The script will not modify it.',
    );
  }
  const projectPolicy = read(runner, ['projects', 'get-iam-policy', s.projectId]);
  const accountBindings = (projectPolicy.bindings ?? []).filter((binding) =>
    binding.members?.includes(`serviceAccount:${e.account}`),
  );
  demand(
    accountBindings.every(
      (binding) => binding.role === e.role && sameCondition(binding.condition, e.condition),
    ),
    'catan-api already has additional or unscoped project permissions. Review them manually; no binding will be removed or broadened.',
  );
  const commands = [];
  if (!pool)
    commands.push([
      'iam',
      'workload-identity-pools',
      'create',
      s.poolId,
      '--location=global',
      '--display-name=Catan Vercel production',
      `--description=${MARKER}`,
    ]);
  if (!provider)
    commands.push([
      'iam',
      'workload-identity-pools',
      'providers',
      'create-oidc',
      s.providerId,
      '--location=global',
      `--workload-identity-pool=${s.poolId}`,
      '--display-name=Catan production on Vercel',
      `--description=${MARKER}`,
      `--issuer-uri=${e.issuer}`,
      '--attribute-mapping=google.subject=assertion.sub',
      `--attribute-condition=${e.trust}`,
    ]);
  if (!account)
    commands.push([
      'iam',
      'service-accounts',
      'create',
      s.serviceAccountId,
      '--display-name=Catan Vercel API',
      `--description=${MARKER}`,
    ]);
  if (!role)
    commands.push([
      'iam',
      'roles',
      'create',
      s.roleId,
      '--title=Catan Firestore data',
      `--description=${MARKER}`,
      '--stage=GA',
      `--permissions=${PERMISSIONS.join(',')}`,
    ]);
  if (!(accountPolicy.bindings ?? []).some((binding) => binding.members?.includes(e.principal)))
    commands.push([
      'iam',
      'service-accounts',
      'add-iam-policy-binding',
      e.account,
      '--role=roles/iam.workloadIdentityUser',
      `--member=${e.principal}`,
      '--condition=None',
    ]);
  if (!accountBindings.length)
    commands.push([
      'projects',
      'add-iam-policy-binding',
      s.projectId,
      `--member=serviceAccount:${e.account}`,
      `--role=${e.role}`,
      `--condition=expression=${e.condition.expression},title=${e.condition.title},description=${e.condition.description}`,
    ]);
  return commands.map((command) => [...command, `--project=${s.projectId}`]);
}
export function setup({ apply = false, runner = gcloud, log = console.log } = {}) {
  const project = runner(['projects', 'describe', SETTINGS.projectId]);
  demand(
    project.projectId === SETTINGS.projectId && project.lifecycleState === 'ACTIVE',
    'Refusing to operate on a different or inactive Google Cloud project.',
  );
  const e = expected(String(project.projectNumber));
  log(`${apply ? 'APPLY' : 'REVIEW ONLY'}: ${SETTINGS.projectId} / ${SETTINGS.databaseId}`);
  log(
    `Trusted workload: ${SETTINGS.teamSlug}/${SETTINGS.projectName} (${SETTINGS.environment} only).`,
  );
  log(`Service identity: ${e.account}; no private keys will be created.`);
  log(
    'IAM scope covers data in the entire default database, including other collections stored there. Firestore IAM cannot restrict this identity to catan/rankings. No records or Security Rules are changed.',
  );
  const services = read(runner, ['services', 'list', '--enabled']);
  demand(Array.isArray(services), 'Could not inspect enabled Google APIs.');
  const enabled = new Set(services.map((value) => value.config?.name));
  const missing = APIS.filter((api) => !enabled.has(api));
  if (missing.length) {
    const command = ['services', 'enable', ...missing, `--project=${SETTINGS.projectId}`];
    log(display(command));
    if (!apply) {
      log(
        'Required APIs are disabled. Apply will enable these APIs, then inspect all existing trust resources before planning any IAM changes. Rerun review after enabling them to see the complete current plan.',
      );
      return { complete: false, commands: [command] };
    }
    runner(command);
  }
  const commands = inspect(runner, String(project.projectNumber));
  if (!commands.length)
    log('The reviewed trust and permission bindings already match; no changes needed.');
  for (const command of commands) {
    log(display(command));
    if (apply) runner(command);
  }
  if (apply) {
    const remaining = inspect(runner, String(project.projectNumber));
    demand(
      remaining.length === 0,
      'Setup did not converge. Inspect existing resources and rerun; no automatic changes to existing resources will occur.',
    );
    log(
      'Trust verified. In Vercel select the team OIDC issuer mode and redeploy production after setting the Firebase web config.',
    );
  } else
    log(
      'No cloud changes made. Review the commands and database-wide scope, then rerun with --apply when ready.',
    );
  return { complete: true, commands };
}
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(
      'Usage: node scripts/setup-vercel-firestore.mjs [--apply]\nDefault: read-only inspection and a command plan. --apply explicitly enables required APIs and creates only missing, validated Catan trust resources and additive bindings. Requires Google Cloud CLI signed in with setup permissions.',
    );
    return;
  }
  demand(
    args.every((arg) => arg === '--apply') && args.length <= 1,
    'Only --apply or --help is supported. Project and trusted workload identifiers are fixed in the reviewed script.',
  );
  setup({ apply: args.includes('--apply') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Setup failed.');
    process.exitCode = 1;
  }
}
