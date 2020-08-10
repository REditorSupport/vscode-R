'use strict'

import { existsSync } from 'fs-extra'
import { window, workspace, WorkspaceConfiguration } from 'vscode'
import path = require('path')
import fs = require('fs')
import Winreg = require('winreg')

export function config (): WorkspaceConfiguration {
  return workspace.getConfiguration('r')
}

function getRfromEnvPath (platform: string): string {
  let splitChar = ':'
  let fileExtension = ''

  if (platform === 'win32') {
    splitChar = ';'
    fileExtension = '.exe'
  }

  const osPaths: string[]|string = process.env.PATH.split(splitChar)
  for (const osPath of osPaths) {
    const osRPath: string = path.join(osPath, 'R' + fileExtension)
    if (fs.existsSync(osRPath)) {
      return osRPath
    }
  }
  return ''
}

export async function getRpath (): Promise<string> {
  let rpath = ''
  const platform: string = process.platform

  if (platform === 'win32') {
    rpath = config().get<string>('rterm.windows')
    if (rpath === '') {
      // Find path from registry
      try {
        const key = new Winreg({
          hive: Winreg.HKLM,
          key: '\\Software\\R-Core\\R'
        })
        const item: Winreg.RegistryItem = await new Promise((resolve, reject) =>
          key.get('InstallPath', (err, result) => err === null ? resolve(result) : reject(err)))
        rpath = path.join(item.value, 'bin', 'R.exe')
      } catch (e) {
        rpath = ''
      }
    }
  } else if (platform === 'darwin') {
    rpath = config().get<string>('rterm.mac')
  } else if (platform === 'linux') {
    rpath = config().get<string>('rterm.linux')
  }

  if (rpath === '') {
    rpath = getRfromEnvPath(platform)
  }
  if (rpath !== '') {
    return rpath
  }
  await window.showErrorMessage(`${process.platform} can't use R`)
  return undefined
}

export function ToRStringLiteral (s: string, quote: string): string {
  if (s === undefined) {
    return 'NULL'
  }

  return (quote +
        s.replace(/\\/g, '\\\\')
          .replace(/"""/g, `\\${quote}`)
          .replace(/\\n/g, '\\n')
          .replace(/\\r/g, '\\r')
          .replace(/\\t/g, '\\t')
          .replace(/\\b/g, '\\b')
          .replace(/\\a/g, '\\a')
          .replace(/\\f/g, '\\f')
          .replace(/\\v/g, '\\v') +
        quote)
}

export async function delay (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function checkForSpecialCharacters (text: string): boolean {
  return !/[~`!#$%^&*+=\-[\]\\';,/{}|\\":<>?\s]/g.test(text)
}

export function checkIfFileExists (filePath: string): boolean {
  return existsSync(filePath)
}
