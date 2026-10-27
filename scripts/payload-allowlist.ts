/** The reviewed npm payload inventory, independent of package.json exports.
 * A new module or translation requires an explicit change here so merely
 * exporting a path cannot silently authorize extra files in the tarball.
 * Keep both this and the separate manifest-derived required-file check.
 */
const metadata = ['package.json', 'LICENSE', 'README.md', 'README.zh.md', 'icon.svg', 'cordis.patch.yml']
const modules = ['index', 'admission', 'webserver', 'tls', 'startup', 'pairing', 'keep-awake']
const localeDirectories = ['', 'startup/', 'tls/', 'webserver/', 'pairing/', 'keep-awake/']

export const permittedPayloadPaths: ReadonlySet<string> = new Set([
  ...metadata,
  ...modules.flatMap(name => [`lib/${name}.js`, `lib/types/${name}.d.ts`]),
  ...localeDirectories.flatMap(dir => ['en', 'zh'].map(lang => `locale/${dir}${lang}.json`)),
])
