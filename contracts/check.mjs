// 契约一致性检查（pnpm contracts:check 的第二步）。与 generate.mjs 同理置于 contracts/：
// 只校验本目录的源与生成产物（路由、错误码、Dashboard api.ts 对齐），不涉及仓库其他目录布局。
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openapiPath = resolve(root, 'contracts/http.openapi.yaml');
const openapi = await readFile(openapiPath, 'utf8');

const fail = (message) => {
  throw new Error(`contracts:check: ${message}`);
};
if (!/^openapi:\s*3\.1\.\d+\s*$/m.test(openapi)) fail('http.openapi.yaml must declare OpenAPI 3.1');
if (!/^paths:\s*$/m.test(openapi)) fail('http.openapi.yaml has no paths section');

const externalRefs = [...openapi.matchAll(/\$ref:\s*['"]?(\.\/proto\/[^'" }\r\n]+)['"]?/g)].map(
  (match) => match[1],
);
async function checkRefs(sourcePath, refs) {
  for (const ref of new Set(refs)) {
    const [file, fragment] = ref.split('#');
    let document;
    try {
      document = JSON.parse(await readFile(resolve(dirname(sourcePath), file), 'utf8'));
    } catch (error) {
      fail(`cannot load ${ref}: ${error.message}`);
    }
    if (fragment) {
      const segments = fragment
        .replace(/^#?\//, '')
        .split('/')
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
      let value = document;
      for (const segment of segments) value = value?.[segment];
      if (value === undefined) fail(`unresolved reference ${ref} in ${sourcePath}`);
    }
  }
}
await checkRefs(openapiPath, externalRefs);
for (const name of ['peer.schema.json', 'signal.schema.json']) {
  const sourcePath = resolve(root, 'contracts/proto', name);
  const document = JSON.parse(await readFile(sourcePath, 'utf8'));
  await checkRefs(
    sourcePath,
    [...JSON.stringify(document).matchAll(/"\$ref"\s*:\s*"(\.\/[^" ]+)"/g)].map(
      (match) => match[1],
    ),
  );
}
// The JSON schemas are source contracts, so checking their external references here keeps
// the check independent of any optional OpenAPI/JSON-schema command line package.

const contractRoutes = new Set();
const pathPattern = /^ {2}(\/[^:]+):\s*$/gm;
const methodPattern = /^ {4}(get|put|post|patch|delete|head|options):\s*$/gm;
let pathMatch;
while ((pathMatch = pathPattern.exec(openapi))) {
  const path = pathMatch[1];
  const end = pathPattern.exec(openapi)?.index ?? openapi.length;
  pathPattern.lastIndex = pathMatch.index + pathMatch[0].length;
  const block = openapi.slice(pathMatch.index, end);
  const methods = [...block.matchAll(methodPattern)];
  for (const [index, method] of methods.entries()) {
    // Slice to the next method: a bare operationId test against the whole path block would
    // let any later method in the same path satisfy this one's check.
    const operation = block.slice(method.index, methods[index + 1]?.index);
    if (!/^ {6}operationId:\s*\S+/m.test(operation))
      fail(`${method[1].toUpperCase()} ${path} is missing operationId`);
    contractRoutes.add(`${method[1].toUpperCase()} ${path}`);
  }
}
if (!contractRoutes.size) fail('no HTTP operations found');

// operationIds must be unique: they are the shared key between the contract, generated
// consumers, and error-code tables.
const operationIds = [...openapi.matchAll(/^\s{6}operationId:\s*(\S+)\s*$/gm)].map(
  (match) => match[1],
);
const duplicateIds = operationIds.filter((id, index) => operationIds.indexOf(id) !== index);
if (duplicateIds.length) fail(`duplicate operationIds: ${[...new Set(duplicateIds)].join(', ')}`);

const normalizeContractPath = (path) => path.replace(/\{[^/}]+\}/g, '{}');
const contractEndpoints = new Set(
  [...contractRoutes].map((route) => {
    const [method, path] = route.split(' ');
    return `${method} ${normalizeContractPath(path)}`;
  }),
);

// Dashboard parity: every RTK Query endpoint in stores/api.ts must target a declared operation.
// URL expressions are extracted per AST (strings, template holes as {}, ternaries) so refactors
// of the endpoint table cannot silently introduce undeclared REST calls.
const apiSource = await readFile(resolve(root, 'dashboard/src/stores/api.ts'), 'utf8');
const apiFile = ts.createSourceFile(
  'api.ts',
  apiSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const dashboardEndpoints = new Set();
const optionalQuerySpan = (span) => {
  // The `${requestId ? `?requestId=...` : ''}` pattern appends an optional query string; the
  // hole and everything after it are not part of the declared path.
  let found = false;
  const scan = (node) => {
    if (ts.isTemplateExpression(node) && node.head.text.startsWith('?')) found = true;
    ts.forEachChild(node, scan);
  };
  scan(span.expression);
  return found;
};
const pathFragments = (expr) => {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
  if (ts.isParenthesizedExpression(expr)) return pathFragments(expr.expression);
  if (ts.isConditionalExpression(expr))
    return [...pathFragments(expr.whenTrue), ...pathFragments(expr.whenFalse)];
  if (ts.isTemplateExpression(expr)) {
    let path = expr.head.text;
    for (const span of expr.templateSpans) {
      if (optionalQuerySpan(span)) return [path];
      path += '{}' + span.literal.text;
    }
    return [path];
  }
  return [];
};
const unextractedEndpoints = [];
const unwrapParenthesized = (expr) =>
  ts.isParenthesizedExpression(expr) ? unwrapParenthesized(expr.expression) : expr;
const visitApi = (node) => {
  if (
    ts.isPropertyAssignment(node) &&
    (node.name.getText() === 'query' || node.name.getText() === 'url')
  ) {
    let fragments = [];
    let method = 'GET';
    const init = node.initializer;
    if (node.name.getText() === 'url') {
      fragments = pathFragments(init);
      const object = node.parent;
      const methodProperty = object.properties.find(
        (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'method',
      );
      if (methodProperty && ts.isStringLiteral(methodProperty.initializer))
        method = methodProperty.initializer.text;
    } else if (
      ts.isArrowFunction(init) &&
      !ts.isObjectLiteralExpression(unwrapParenthesized(init.body))
    ) {
      fragments = pathFragments(init.body);
    }
    for (const fragment of fragments) {
      const path = fragment.split('?')[0].replace(/\/$/, '');
      if (path) dashboardEndpoints.add(`${method} /api/${path}`);
    }
    // Extraction must fail closed: an endpoint whose path cannot be read statically would
    // otherwise silently skip the parity check below. An arrow returning an object literal
    // delegates extraction to its `url` property, which is visited on its own.
    if (!fragments.length) {
      const delegatesToUrl =
        ts.isArrowFunction(init) &&
        ts.isObjectLiteralExpression(unwrapParenthesized(init.body)) &&
        unwrapParenthesized(init.body).properties.some(
          (property) => ts.isPropertyAssignment(property) && property.name.getText() === 'url',
        );
      if (!delegatesToUrl) {
        let owner = node.parent;
        while (
          owner &&
          !(ts.isPropertyAssignment(owner) && !['query', 'url'].includes(owner.name.getText()))
        )
          owner = owner.parent;
        unextractedEndpoints.push(owner ? owner.name.getText() : node.name.getText());
      }
    }
  }
  ts.forEachChild(node, visitApi);
};
ts.forEachChild(apiFile, visitApi);
if (unextractedEndpoints.length)
  fail(
    `dashboard api.ts endpoints with unextractable paths: ${[...new Set(unextractedEndpoints)].join(', ')}`,
  );
const undeclaredEndpoints = [...dashboardEndpoints].filter(
  (endpoint) => !contractEndpoints.has(endpoint),
);
if (undeclaredEndpoints.length)
  fail(`dashboard api.ts calls not declared in OpenAPI: ${undeclaredEndpoints.join(', ')}`);

const backendDir = resolve(root, 'backend/internal/server');
const backendRoutes = new Set();
for (const file of await readdir(backendDir)) {
  if (!file.endsWith('.go')) continue;
  const source = await readFile(resolve(backendDir, file), 'utf8');
  for (const match of source.matchAll(/(?:HandleFunc|Handle)\(\s*"([A-Z]+)\s+([^"]+)"/g)) {
    const path = match[2].replace(/\{\s*([^}]+?)\.\.\.\s*\}/g, '{$1}');
    if (path === '/') continue;
    backendRoutes.add(`${match[1]} ${path}`);
  }
}
const missingRoutes = [...backendRoutes].filter((route) => !contractRoutes.has(route));
if (missingRoutes.length) fail(`backend routes missing from OpenAPI: ${missingRoutes.join(', ')}`);
const extraRoutes = [...contractRoutes].filter((route) => !backendRoutes.has(route));
if (extraRoutes.length)
  fail(`OpenAPI routes missing from Go registration: ${extraRoutes.join(', ')}`);

const errorText = await Promise.all(
  (await readdir(backendDir))
    .filter((file) => file.endsWith('.go'))
    .map((file) => readFile(resolve(backendDir, file), 'utf8')),
);
const emittedErrors = new Set();
// Error codes also reach clients as generated constants (contracts.SignalErrorXxx /
// contracts.ErrorCodeXxx), as ErrorBody struct literals, and as sentinel errors, none of
// which appear as an apiError(...) string argument; resolve them from the generated tables.
const generatedErrorConstants = new Map();
for (const artifact of ['contracts/go/errors.gen.go', 'contracts/go/protocol.gen.go']) {
  const source = await readFile(resolve(root, artifact), 'utf8');
  for (const match of source.matchAll(
    /^\s*(ErrorCode\w+|SignalError\w+)(?:\s+\w+)?\s*=\s*"([a-z][a-z0-9_]+)"\s*$/gm,
  )) {
    generatedErrorConstants.set(match[1], match[2]);
  }
}
for (const source of errorText) {
  for (const match of source.matchAll(
    /(?:apiError(?:Detail)?|fail(?:Detail)?)\([^\r\n]*?"([a-z][a-z0-9_]+)"/g,
  )) {
    emittedErrors.add(match[1]);
  }
  for (const match of source.matchAll(/Code:\s*"([a-z][a-z0-9_]+)"/g)) emittedErrors.add(match[1]);
  for (const match of source.matchAll(/errors\.New\(\s*"([a-z][a-z0-9_]+)"\s*\)/g))
    emittedErrors.add(match[1]);
  for (const match of source.matchAll(/contracts\.(ErrorCode\w+|SignalError\w+)/g)) {
    const code = generatedErrorConstants.get(match[1]);
    if (code) emittedErrors.add(code);
  }
}
const errorSection =
  openapi.match(/^\s{4}ErrorCode:\s*$([\s\S]*?)(?=^\s{4}\w|$(?![\s\S]))/m)?.[1] ?? '';
const declaredErrors = new Set(
  [...errorSection.matchAll(/^\s{8}-\s+([a-z][a-z0-9_]+)/gm)].map((match) => match[1]),
);
const undeclaredErrors = [...emittedErrors].filter((code) => !declaredErrors.has(code));
if (undeclaredErrors.length)
  fail(`backend error codes missing from ErrorCode enum: ${undeclaredErrors.join(', ')}`);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}
const versionRoots = [
  resolve(root, 'backend'),
  resolve(root, 'dashboard/src'),
  resolve(root, 'overlay/src'),
  resolve(root, 'scripts'),
];
const versionLiterals = /(?:schemaVersion\s*[:=]\s*1|SchemaVersion\s*(?:===|!==|==|!=)\s*1)/;
const versionViolations = [];
for (const file of (await Promise.all(versionRoots.map(walk))).flat()) {
  if (
    !/\.(go|ts|tsx|cs|mjs)$/.test(file) ||
    /(?:\.gen\.|Defaults\.g\.cs$)/.test(file) ||
    /_test\.(go|mjs)$/.test(file)
  )
    continue;
  const source = await readFile(file, 'utf8');
  if (versionLiterals.test(source)) versionViolations.push(file.slice(root.length + 1));
}
if (versionViolations.length)
  fail(
    `schemaVersion literals must use generated contract constants: ${versionViolations.join(', ')}`,
  );

console.log(
  `contracts:check ok (${contractRoutes.size} operations, ${externalRefs.length} external refs, ${declaredErrors.size} error codes)`,
);
