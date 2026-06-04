const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const inquirer = require('inquirer');
const state = require('../state');
const { imageToBase64, isVisionModel } = require('../utils/image');
const config = require('../config');

let currentPickerDir = process.cwd();

async function filePicker() {
  try {
    const dir = currentPickerDir;
    if (!fs.existsSync(dir)) {
      currentPickerDir = process.cwd();
      return await filePicker();
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const choices = [];

    if (dir !== path.parse(dir).root) {
      choices.push({ name: chalk.yellow('📁 ../ 返回上级目录'), value: '..' });
    }

    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    dirs.forEach(d => {
      choices.push({ name: chalk.cyan(`📁 ${d.name}/`), value: `dir:${d.name}` });
    });

    const files = entries
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));

    files.forEach(f => {
      choices.push({ name: `📄 ${f.name}`, value: `file:${f.name}` });
    });

    if (choices.length === 0) {
      console.log(chalk.gray("当前目录无文件/文件夹"));
      return null;
    }

    const { selected } = await inquirer.prompt([{
      type: 'list',
      name: 'selected',
      message: `当前目录：${dir}`,
      choices,
      pageSize: 20
    }]);

    if (selected === '..') {
      currentPickerDir = path.dirname(dir);
      return await filePicker();
    }

    if (selected.startsWith('dir:')) {
      currentPickerDir = path.join(dir, selected.replace('dir:', ''));
      return await filePicker();
    }

    if (selected.startsWith('file:')) {
      const fileName = selected.replace('file:', '');
      const filePath = path.join(dir, fileName);

      try {
        if (/\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileName) && isVisionModel(config.get('API_MODEL'))) {
          const base64 = await imageToBase64(filePath);
          state.attachedFiles.push({ name: fileName, content: base64, type: 'image' });
          console.log(chalk.green(`📎 已附加图像：${fileName}`));
        } else {
          const content = fs.readFileSync(filePath, 'utf8');
          state.attachedFiles.push({ name: fileName, content: content.substring(0, 30000), type: 'text' });
          console.log(chalk.green(`📎 已附加文件：${fileName}`));
        }
        return fileName;
      } catch (e) {
        console.log(chalk.red(`读取失败：${e.message}`));
        return null;
      }
    }
  } catch (e) {
    console.log(chalk.red(`目录读取异常：${e.message}`));
    currentPickerDir = process.cwd();
    return null;
  }
}

module.exports = { filePicker };
