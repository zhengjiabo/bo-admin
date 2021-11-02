const args = require('minimist')(process.argv.slice(2))
const childProcess = require('child_process');
const chalk = require('chalk') // 颜色控制台
const { prompt } = require('enquirer') // 交互询问
const execa = require('execa');

const isDryRun = args.dry
const step = (() => {
  let num = 0
  return msg => console.log(chalk.cyan(`${++num}. ${msg}`))
})()
const run = (bin, args, opts = {}, isShell) => isShell ? execa.shell(bin, opts) : execa(bin, args, { stdio: 'inherit', ...opts })
const dryRun = (bin, args, opts = {}) => chalk.blue(`[dryrun] ${bin} ${args.join(' ')}`, opts)
const runIfNotDry = isDryRun ? dryRun : run

async function main () {
  let commitMessage

  // 核验暂存区是否有代码, 本地
  step('开始校验本地暂存区和工作区是否有代码')
  if (await isDiff()) {
    const choices = [
      {
        message: '缓存', value: 'stash', hint: '(stash)'
      },
      { message: '版本库', value: 'commit', hint: '(commit)' },
      { message: '取消', value: 'cancel', hint: '(cancel)' }
    ]
    const { type } = await prompt({
      type: 'select',
      name: 'type',
      message: '本地代码有变更，请选择如何处理这些代码:',
      choices
    })

    if (['stash', 'commit'].includes(type)) {
      const typeName = type === 'stash' ? '缓存' : '版本库'
      const { yes } = await prompt({
        type: 'confirm',
        name: 'yes',
        message: `确认将这些代码提交到${chalk.yellow(typeName)}, 确认?`
      })
      if (!yes) return // 取消
    } else { // 取消
      return
    }

    if (type === 'stash') {
      const dateFormat = function (date, format = 'yyyy-MM-dd hh:mm:ss') {
        if (date !== 'Invalid Date') {
          var o = {
            'M+': date.getMonth() + 1, // month
            'd+': date.getDate(), // day
            'h+': date.getHours(), // hour
            'm+': date.getMinutes(), // minute
            's+': date.getSeconds(), // second
            'q+': Math.floor((date.getMonth() + 3) / 3), // quarter
            S: date.getMilliseconds() // millisecond
          }
          if ((/(y+)/).test(format)) {
            format = format.replace(RegExp.$1,
              (`${date.getFullYear()}`).substr(4 - RegExp.$1.length))
          }
          for (var k in o) {
            if (new RegExp(`(${k})`).test(format)) {
              format = format.replace(RegExp.$1,
                RegExp.$1.length === 1 ? o[k]
                  : (`00${o[k]}`).substr((`${o[k]}`).length))
            }
          }
          return format
        }
        return ''
      }
      const dateStr = dateFormat(new Date())

      await runIfNotDry('git', [
        'stash',
        'push',
        '-u',
        '-m',
        dateStr
      ])
      console.log(`本地变更代码已提交到缓存: ${chalk.yellow(dateStr)}`)
    } else if (type === 'commit') {
      commitMessage = (await prompt({
        type: 'input',
        name: 'message',
        message: '请输入变更代码的commit提交信息',
        initial: '',
        required: true
      })).message
      console.log('提交信息已存储, 等待配置完成后commit') // eslint校验太久, 后续配置项全部提交完再commit
    }
  }

  let targetVersion = args._[0] // 第一个无键值匹配的为版本

  if (!targetVersion) { // 无版本 自动取得最大版本的信息
    const tagInfo = await getFinalTag().catch(err => console.log(err.message)) || {}
    const { flag, minor, patch, date, tag } = tagInfo

    step(`已获取到Git上最大版本tag为: ${chalk.yellow(tag)}`)

    const minorTag = `${flag}_${minor * 1 + 1}_01_yyyyMMdd`
    let increasePatch = `${patch * 1 + 1}`
    increasePatch = increasePatch.length === 1 ? `0${increasePatch}` : increasePatch
    const patchTag = `${flag}_${minor}_${increasePatch}_${date}`

    const choices = [
      {
        message: `修订版本: ${patchTag}`, value: 'patch', hint: '(patch)'
      },
      { message: `次版本: ${minorTag}`, value: 'minor', hint: '(minor)' },
      { message: '自定义', value: 'custom', hint: '(custom)' }
    ]
    const { type } = await prompt({
      type: 'select',
      name: 'type',
      message: '请选择标签的类型:',
      choices
    })

    if (type === 'patch') { // 修订版本
      targetVersion = patchTag
    } else if (type === 'minor') { // 次版本
      const nextDate = await getNextDate()
      targetVersion = minorTag.replace('yyyyMMdd', nextDate)
    } if (type === 'custom') { // 自定义
      targetVersion = await getCustomTag(minorTag)
    }
  }

  // 到此都是有版本号 核验版本是否正常
  if (!(/.*?_(\d+)_\d+_(\d+)/).test(targetVersion)) {
    throw new Error(`无效版本号:${targetVersion}`)
  }

  let { yes } = await prompt({
    type: 'confirm',
    name: 'yes',
    message: `是否打标签为: ${chalk.yellow(targetVersion)}, 确认?`
  })
  if (yes) {
    yes = (await prompt({
      type: 'confirm',
      name: 'yes',
      message: `是否打标签为: ${chalk.yellow(targetVersion)}, 再次确认?`
    })).yes
  }

  if (!yes) {
    return
  }

  if (commitMessage) {
    step('开始commit本地代码')
    await runIfNotDry('git', [
      'add', '-A'
    ])
    await runIfNotDry('git', [
      'commit', '-m', commitMessage
    ])
    console.log(`本地变更代码已提交到版本库, 提交信息: ${chalk.yellow(commitMessage)}`)
  }

  // 开始打标签
  step('开始核验对应标签的分支是否存在')

  const [, date] = targetVersion.match(/.*?_\d+_\d+_(\d+)/)
  if (!(await getOriginBranch('20211029'))) {
    throw new Error(`标签${chalk.yellow(targetVersion)}对应日期${chalk.red(date)}分支, 不存在于远程仓库`)
  }
  console.log('校验成功: 分支存在')

  // 更新对应标签的分支代码到本地
  step(`开始更新远程分支${chalk.yellow(date)}的代码到本地`)
  await runIfNotDry('git', ['fetch', 'origin', date])
  await runIfNotDry('git', ['merge', `origin/${date}`])
  const { branch, oriBranch } = await getNowOriginBranch()

  step('开始提交代码到个人远程分支')
  await runIfNotDry('git', ['push', 'origin', `${branch}:${oriBranch}`]) // 本地分支到个人远程推送oriBranch
  await runIfNotDry('git', ['branch', '-u', `origin/${date}`]) // 更改跟踪
  step(`开始提交代码到${chalk.yellow(date)}远程分支`)
  await runIfNotDry('git', ['push', 'origin', `${branch}:${date}`]) // 本地分支到日期远程推送
  await runIfNotDry('git', ['branch', '-u', `origin/${oriBranch}`]) // 更改跟踪-复原

  step('开始打标签并提交远程')
  await runIfNotDry('git', ['tag', targetVersion])
  await runIfNotDry('git', ['push', 'origin', `refs/tags/${targetVersion}`]) // 删除远程同名标签
  await runIfNotDry('git', ['push']) // 推送

  console.log(`操作成功: 新建标签为: ${chalk.green(targetVersion)}`)
}

/**
 * 核验是否本地文件是否有改动
 */
async function isDiff () {
  const [error, stdout, stderr] = await new Promise(resolve => {
    childProcess.exec('git diff', {}, (...params) => resolve(params))
  })

  if (error) {
    throw new Error(`isDiff: ${error} ${stderr}`)
  }

  if (!stdout) {
    const [error, stdout, stderr] = await new Promise(resolve => {
      childProcess.exec('git status', {}, (...params) => resolve(params))
    })
    if (error) {
      throw new Error(`isDiff: ${error} ${stderr}`)
    }
    return stdout
  }
  return stdout
}

/**
 * 取得最大的版本标签
 */
async function getFinalTag () {
  const { error, stdout, stderr } = await runIfNotDry('git ls-remote | grep -v "\\^" | grep -o "refs/tags/.*"', [], {}, true)

  if (error) {
    throw new Error(`getFinalTag: ${error} ${stderr}`)
  }
  const tagsArr = stdout.split('\n').map(tag => tag.replace('refs/tags/', '')).filter(tag => tag)
  const regMax = /(.*?)_(\d+)_(\d+)_(\d+)/

  // 取得最大次版本号, 日期
  const { maxMinor, maxDate, tag } = tagsArr.reduce((total, tag) => {
    const { maxMinor, maxPatch, maxDate } = total
    const [, , minor,
      patch,
      date] = (tag || '').match(regMax)
    if (maxMinor * 1 < minor * 1) {
      Object.assign(total, { maxMinor: minor, maxPatch: patch, tag })
    } else if (maxMinor * 1 === minor * 1 && maxPatch * 1 < patch * 1) {
      Object.assign(total, { maxPatch: patch, tag })
    }

    if (maxDate * 1 < date * 1) {
      Object.assign(total, { maxDate: date, maxPatch: patch, tag })
    } else if (maxDate * 1 === date * 1 && maxPatch * 1 < patch * 1) {
      Object.assign(total, { maxPatch: patch, tag })
    }
    return total
  }, { maxMinor: '', maxDate: '', maxPatch: '', tag: '' })

  // 没有取到标签, 提前返回
  if (!tag) {
    throw new Error('getFinalTag: 没有取到最大版本标签')
  }

  const [
    ,
    flag,
    minor,
    patch,
    date
  ] = (tag || '').match(regMax)
  if (maxMinor !== minor) {
    throw new Error(`getFinalTag: 最大版本标签${tag}的版本号${minor}，不是最大版本号${maxMinor}`)
  }
  if (maxDate !== date) {
    throw new Error(`getFinalTag: 最大版本标签${tag}的日期${date}，不是最大日期${maxDate}`)
  }

  // 外部需要用到Minor, 去加1与tag结合作为新版本号.
  return { flag, minor, patch, date, tag }
}

/**
 * 获取下版本时间点
 */
async function getNextDate () {
  const newDate = (await prompt({
    type: 'input',
    name: 'version',
    message: '已选择次版本类型, 请输入下个版本时间',
    initial: '例如: 20210930'
  })).version
  if ((/^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])$/).test(newDate)) {
    return newDate
  } else {
    console.log('下个版本时间点格式错误，请参考yyyyMMdd格式重新输入')
    return getNextDate()
  }
}

/**
 * 获取自定义版本
 */
async function getCustomTag (minorTag) {
  const tag = (await prompt({
    type: 'input',
    name: 'version',
    message: `请输入自定义版本, 下版本参考前缀${minorTag.replace('yyyyMMdd', '')}`,
    initial: ''
  })).version

  if ((/^.+_\d+_\d+_20\d{2}(0[1-9]|1[0-2])(0[1-9]|[1-2][0-9]|3[0-1])$/).test(tag)) {
    return tag
  } else {
    console.log('自定义版本格式错误，请参考.+_\\d+_\\d+_yyyyMMdd格式重新输入')
    return getCustomTag(minorTag)
  }
}

/**
 * 判断远程分支是否存在
 */
async function getOriginBranch (branch) {
  const [error, stdout, stderr] = await new Promise(resolve => {
    childProcess.exec('git branch -r', {}, (...params) => resolve(params))
  })

  if (error) {
    throw new Error(`getOriginBranch: ${error} ${stderr}`)
  }
  const branchArr = stdout.split('\n').map(str => str.slice(str.lastIndexOf('/') + 1)).filter(branch => branch)

  return branchArr.includes(branch)
}

async function getNowOriginBranch () {
  const { error, stdout, stderr } = await runIfNotDry('git', ['branch', '-vv'], { stdio: '' })

  if (error) {
    throw new Error(`getNowOriginBranch: ${error} ${stderr}`)
  }
  const branchRaw = stdout.split('\n').filter(branchName => (/^\*/).test(branchName))[0]
  const [, branch, oriBranch] = branchRaw.match(/^\*\s(.*?)\s+[\w\W]*?\[origin\/(.*?)(:.*?)?\]/)
  console.log(branchRaw)
  return { branch, oriBranch }
}

/**
 * 判断远程是否有未合并请求
 */
// async function getOriginMerge (branch) {
//   const [error, stdout, stderr] = await new Promise(resolve => {
//     childProcess.exec('git branch -r', {}, (...params) => resolve(params))
//   })

//   if (error) {
//     throw new Error(`getOriginBranch: ${error} ${stderr}`)
//   }
//   const branchArr = stdout.split('\n').map(str => str.slice(str.lastIndexOf('/') + 1)).filter(branch => branch)

//   return branchArr.includes(branch)
// }

main().catch(err => { // 主程序入口
  console.error(err)
})
