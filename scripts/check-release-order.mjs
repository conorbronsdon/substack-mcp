import semver from 'semver';

export function classifyRelease(localVersion, publishedVersion) {
  if (!semver.valid(localVersion)) {
    throw new Error(`Invalid local version: ${localVersion}`);
  }
  if (publishedVersion === 'none') return 'first';
  if (!semver.valid(publishedVersion)) {
    throw new Error(`Invalid published version: ${publishedVersion}`);
  }
  if (semver.eq(localVersion, publishedVersion)) return 'same';
  if (semver.gt(localVersion, publishedVersion)) return 'upgrade';
  throw new Error(
    `Refusing non-monotonic release: local ${localVersion} is older than published ${publishedVersion}`,
  );
}

if (process.argv[1]?.endsWith('check-release-order.mjs')) {
  try {
    console.log(classifyRelease(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
