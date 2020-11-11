


import * as cp from 'child_process';

import * as http from 'http';

import * as rHelpPanel from './rHelpPanel';

export interface RHelpClientOptions extends rHelpPanel.RHelpProviderOptions {
	// path of the R executable. Could be left out (with limited functionality)
    rPath: string;
}


// Class to forward help requests to a backgorund R instance that is running a help server
export class RHelpClient implements rHelpPanel.HelpProvider {
    private cp: cp.ChildProcess;
    private port: number|Promise<number>;
    private readonly rPath: string;

    public constructor(options: RHelpClientOptions){
        this.rPath = options.rPath || 'R';
        this.port = this.launchRHelpServer(); // is a promise for now!
    }

    public async launchRHelpServer(){
        // starts the background help server and waits forever to keep the R process running
        const cmd = (
            `${this.rPath} --silent --slave --vanilla -e ` +
            `"cat(tools::startDynamicHelp(),'\\n'); while(TRUE) Sys.sleep(1)" ` 
        );
        this.cp = cp.exec(cmd);

        console.log(cmd);

        // promise containing the first output of the r process (contains only the port number)
        const outputPromise = new Promise<string>((resolve, reject) => {
            this.cp.stdout.on('data', (data) => {
                resolve(data.toString());
            });
            this.cp.on('close', (code) => {
                console.log('R process closed with code ' + code);
                reject();
            });
        });

        // await and store port number
        const output = await outputPromise;
        const port = Number(output);

        // is returned as a promise if not called with "await":
        return port;
    }

    public async getHelpFileFromRequestPath(requestPath: string){
        // make sure the server is actually running
        this.port = await this.port;

        console.log(`requesting help for: ${requestPath}`);

        // remove leading '/'
        while(requestPath.startsWith('/')){
            requestPath = requestPath.substr(1);
        }
    
        // forward request to R instance
        // below is just a complicated way of getting a http response from the help server
        const url = `http://localhost:${this.port}/${requestPath}`;
        const htmlPromise = new Promise<string>((resolve, reject) => {
            let content: string = '';
            http.get(url, (res: http.IncomingMessage) => {
                res.on('data', (chunk) => {
                    content += chunk.toString();
                });
                res.on('close', () => {
                    resolve(content);
                });
                res.on('error', () => {
                    reject();
                });
            });
        });

        const html = await htmlPromise;

        // return help file
        const ret: rHelpPanel.HelpFile = {
            requestPath: requestPath,
            html: html,
            isRealFile: false
        };
        return ret;
    }

    dispose(){
        if(this.cp){
            this.cp.kill();
        }
    }
}


