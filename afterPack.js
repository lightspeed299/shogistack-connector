// afterPack hook: signAndEditExecutable: false ではアイコンが埋め込まれないため、
// パッケージング後に rcedit で手動埋め込みする
const path = require('path');

exports.default = async function (context) {
  if (process.platform !== 'win32') return;

  const { rcedit } = require('rcedit');
  const exePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  );
  const iconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');

  console.log(`  • embedding icon via afterPack  exe=${exePath}`);
  await rcedit(exePath, { icon: iconPath });
};
