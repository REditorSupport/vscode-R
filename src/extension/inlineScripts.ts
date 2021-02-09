import * as path from 'path';
import {promises as fs} from "fs";

function getMimeType(ext: string): string {
	switch (ext) {
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'svg':
			return 'image/svg+xml';
		case 'gif':
		case 'png':
		case 'webp':
			return `image/${ext}`;
		default:
			return 'application/octet-stream';
	}
};

export async function inlineImages(html: string, htmlDir: string): Promise<string> {
	const imgTagRegex = /<img (.* )?src="([\w.\-\/]+)"(.*)>/;
	let matches = html.match(new RegExp(imgTagRegex, 'g'));
	if (!matches)
		return html;
	let imgPromises = matches
		.map(imgTag => imgTag.match(imgTagRegex)[2])
		.map(relImgPath => path.resolve(htmlDir, relImgPath))
		.map(imgPath => fs.readFile(imgPath));
	let i = 0;
	return Promise.all(imgPromises).then(images =>
		html.replace(new RegExp(imgTagRegex, 'g'), (_match, p1, p2, p3) =>
			`<img ${p1 || ''}src="data:${getMimeType(p2.split('.').pop())};base64, ${images[i++].toString('base64')}"${p3}>`
		));
}

export async function inlineHtmlScripts(html: string, htmlDir: string): Promise<string> {
	const scriptTagRegex = /<script (?:.* )?src="([\w.\-\/]+)".*><\/script>/;
	let matches = html.match(new RegExp(scriptTagRegex, 'g'));
	if (!matches)
		return html;
	let scriptPromises = matches
		.map(scriptTag => scriptTag.match(scriptTagRegex)[1])
		.map(relScriptPath => path.resolve(htmlDir, relScriptPath))
		.map(scriptPath => fs.readFile(scriptPath, 'utf8'));
	let i = 0;
	return Promise.all(scriptPromises).then(scripts =>
		html.replace(new RegExp(scriptTagRegex, 'g'), () =>
			`<script>${scripts[i++].replace(/<\/script>/g, '<\\/script>')}</script>`));
}

export async function inlineHtmlStyles(html: string, htmlDir: string): Promise<string> {
	const linkTagRegex = /<link (?:.* )?rel="stylesheet"(?:.* )?href="([\w.\-\/]+)".*>|<link (?:.* )?href="([\w.\-\/]+)"(?:.* )?rel="stylesheet".*>/;
	let matches = html.match(new RegExp(linkTagRegex, 'g'));
	if (!matches)
		return html;
	let stylesheetPromises = matches
		.map(linkTag => {
			let m = linkTag.match(linkTagRegex);
			return m[1] || m[2];
		})
		.map(relPath => path.resolve(htmlDir, relPath))
		.map(stylesheetPath => fs.readFile(stylesheetPath, 'utf8'));
	let i = 0;
	return Promise.all(stylesheetPromises).then(stylesheets =>
		html.replace(new RegExp(linkTagRegex, 'g'), () =>
			`<style>${stylesheets[i++]}</style>`));
}

export async function inlineAll(html: string, htmlDir: string): Promise<string> {
	return await inlineHtmlStyles(
		await inlineImages(
			await inlineHtmlScripts(html, htmlDir),
			htmlDir),
		htmlDir)
}