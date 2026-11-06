import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "hankoshell-adk-consumer-"));
const consumer = join(temporary, "consumer");
mkdirSync(consumer);
writeFileSync(
  join(consumer, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
const userConfig = join(temporary, "empty.npmrc");
writeFileSync(userConfig, "registry=https://registry.npmjs.org\n");
const env = { ...process.env, npm_config_userconfig: userConfig };
delete env.NODE_AUTH_TOKEN;
delete env.NPM_TOKEN;

function run(command, args, cwd = consumer, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status})${capture ? `: ${result.stderr}` : ""}`,
    );
  return result.stdout;
}

try {
  const packed = JSON.parse(
    run("npm", ["pack", "--json", "--pack-destination", temporary], root, true),
  )[0];
  const install = [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.npmjs.org",
  ];
  run("npm", [...install, join(temporary, packed.filename)]);
  writeFileSync(
    join(consumer, "base.mjs"),
    `
    import assert from 'node:assert/strict';
    import { normalizeHankoIssuer } from ${JSON.stringify(manifest.name)};
    assert.equal(normalizeHankoIssuer('https://auth.example.test/'), 'https://auth.example.test');
    await import(${JSON.stringify(manifest.name + "/identity")});
    await import(${JSON.stringify(manifest.name + "/identity/server")});
  `,
  );
  run(process.execPath, ["base.mjs"]);

  const peers = [
    "react",
    "react-dom",
    "next-auth",
    "passport-jwt",
    "@alien6-studio/hankoshell-keycloak-theme-builder",
    "@types/react",
    "@types/react-dom",
    "@types/passport-jwt",
    "@types/node",
  ];
  run("npm", [
    ...install,
    ...peers.map((name) => `${name}@${manifest.devDependencies[name]}`),
  ]);
  const entrypoints = [
    "",
    "/authjs",
    "/authjs/session",
    "/passport",
    "/sessions",
    "/sessions/postgres",
    "/identity",
    "/identity/server",
  ];
  writeFileSync(
    join(consumer, "all.mjs"),
    `for (const name of ${JSON.stringify(entrypoints.map((path) => manifest.name + path))}) await import(name);`,
  );
  run(process.execPath, ["all.mjs"]);
  writeFileSync(
    join(consumer, "client.mjs"),
    `
    import { createElement as h } from 'react';
    import { createRoot } from 'react-dom/client';
    import { HankoIdentityScreen } from ${JSON.stringify(manifest.name + "/identity/react")};
    import { HankoIdentityPage, HankoIdentityPortal } from ${JSON.stringify(manifest.name + "/react")};
    if (typeof HankoIdentityPage !== 'function' || typeof HankoIdentityPortal !== 'function') throw new Error('Themed React exports are missing');
    const ui = {
      Page: ({title,children}) => h('main',null,h('h1',null,title),children),
      Section: ({children}) => h('section',null,children), Group: ({children}) => h('div',null,children),
      Status: ({children,role}) => h('p',{role},children),
      Values: ({items}) => h('dl',null,items.map((item,i)=>h('div',{key:i},h('dt',null,item.label),h('dd',null,item.value)))),
      Field: ({label,htmlFor,children}) => h('label',{htmlFor},label,children),
      Input: props=>h('input',props), Textarea: props=>h('textarea',props),
      Select: ({options,id,value,onValueChange})=>h('select',{id,value,onChange:e=>onValueChange(e.currentTarget.value)},options.map(o=>h('option',{key:o.value,value:o.value},o.label))),
      Button: ({tone,...props})=>h('button',props), Members: ()=>h('ul')
    };
    const controller = { account: async()=>({subject:'alice',name:'Packaged Alice',email:'alice@example.test',roles:[],organizations:[],canCreateOrganization:false}), organization:async()=>{throw new Error('Unexpected organization request')} };
    createRoot(document.getElementById('root')).render(h(HankoIdentityScreen,{subject:'alice',controller,ui,page:'profile',locale:'he-IL'}));
  `,
  );
  const bundle = join(consumer, "client.js");
  buildSync({
    entryPoints: [join(consumer, "client.mjs")],
    outfile: bundle,
    bundle: true,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://app.example.test", runScripts: "outside-only" },
  );
  try {
    dom.window.AbortController = globalThis.AbortController;
    dom.window.AbortSignal = globalThis.AbortSignal;
    dom.window.eval(readFileSync(bundle, "utf8"));
    const deadline = Date.now() + 5000;
    while (
      !dom.window.document
        .querySelector("main")
        ?.textContent.includes("Packaged Alice")
    ) {
      if (Date.now() > deadline)
        throw new Error(
          "The packaged React screen did not render its authenticated account",
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    dom.window.close();
  }
  writeFileSync(
    join(consumer, "contract.ts"),
    `
    import type { ComponentProps } from 'react';
    import { HankoIdentityScreen } from ${JSON.stringify(manifest.name + "/identity/react")};
    import { createHankoIdentityClient } from ${JSON.stringify(manifest.name + "/identity")};
    const screen: Pick<ComponentProps<typeof HankoIdentityScreen>, 'subject' | 'controller' | 'locale'> = {
      subject: 'alice', controller: createHankoIdentityClient({ endpoint: '/api/account' }), locale: 'he-IL'
    };
    void screen;
  `,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      files: ["contract.ts"],
    }),
  );
  run(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "-p",
    "tsconfig.json",
  ]);
  console.log(
    `Package consumer checks passed: ${manifest.name}@${manifest.version}, server entrypoints, two bundled React entrypoints and React types.`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
