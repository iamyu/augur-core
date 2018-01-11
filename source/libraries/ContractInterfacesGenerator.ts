import * as fs from "async-file";
import { Abi, AbiFunction, Primitive } from 'ethereum';
import { ContractCompiler } from "./ContractCompiler";
import { CompilerOutput, CompilerOutputContracts } from "solc";
import { Configuration } from './Configuration';


export class ContractInterfaceGenerator {
    private readonly compiler: ContractCompiler;
    private readonly configuration: Configuration;

    public constructor(configuration: Configuration, compiler: ContractCompiler) {
        this.compiler = compiler;
        this.configuration = configuration;
    }

    public async generateContractInterfaces(): Promise<String> {
        const contractsOutput: CompilerOutput = await this.compiler.compileContracts();
        const fileContents: String = this.contractInterfacesTemplate(contractsOutput.contracts);
        await fs.writeFile(this.configuration.contractInterfacesOutputPath, fileContents);
        return fileContents;
    }

    private contractInterfacesTemplate(contracts: CompilerOutputContracts) {
        const contractInterfaces: Array<string> = [];

        // We add Controlled first to let other contracts inherit from it
        contractInterfaces.push(this.contractInterfaceTemplate("Controlled", contracts["Controlled.sol"]["Controlled"].abi));

        for (let globalName in contracts) {
            for (let contractName in contracts[globalName]) {
                const contractAbi: Abi = contracts[globalName][contractName].abi;
                if (contractAbi.length == 0) continue;
                if (contractName == "Controlled") continue;
                contractInterfaces.push(this.contractInterfaceTemplate(contractName, contractAbi));
            }
        }

        return `// THIS FILE IS AUTOMATICALLY GENERATED BY \`generateContractInterfaces.ts\`. DO NOT EDIT BY HAND'

    import BN = require('bn.js');
    import { encodeMethod, decodeParams } from 'ethjs-abi';
    import { AbiFunction } from 'ethereum';
    import { AccountManager } from './AccountManager';
    import { Connector } from './Connector';

    /**
     * By convention, pure/view methods have a \`_\` suffix on them indicating to the caller that the function will be executed locally and return the function's result.  payable/nonpayable functions have both a localy version and a remote version (distinguished by the trailing \`_\`).  If the remote method is called, you will only get back a transaction hash which can be used to lookup the transaction receipt for success/failure (due to EVM limitations you will not get the function results back).
     */

    export class Contract {
        protected readonly connector: Connector;
        protected readonly accountManager: AccountManager;
        public readonly address: string;
        protected readonly defaultGasPrice: BN;

        protected constructor(connector: Connector, accountManager: AccountManager, address: string, defaultGasPrice: BN) {
            this.connector = connector;
            this.accountManager = accountManager;
            this.address = address;
            this.defaultGasPrice = defaultGasPrice;
        }

        protected async localCall(abi: AbiFunction, parameters: Array<any>, sender?: string, attachedEth?: BN): Promise<Array<any>> {
            const from = sender || this.accountManager.defaultAddress;
            const data = encodeMethod(abi, parameters);
            const transaction = Object.assign({ from: from, to: this.address, data: data }, attachedEth ? { value: attachedEth } : {});
            const result = await this.connector.ethjsQuery.call(transaction);
            return decodeParams(abi.outputs.map(x => x.name), abi.outputs.map(x => x.type), result);
        }

        protected async remoteCall(abi: AbiFunction, parameters: Array<any>, sender?: string, gasPrice?: BN, attachedEth?: BN): Promise<string> {
            const from = sender || this.accountManager.defaultAddress;
            const data = encodeMethod(abi, parameters);
            // TODO: remove \`gas\` property once https://github.com/ethereumjs/testrpc/issues/411 is fixed
            const gas = await this.connector.ethjsQuery.estimateGas(Object.assign({ to: this.address, from: from, data: data }, attachedEth ? { value: attachedEth } : {} ));
            gasPrice = gasPrice || this.defaultGasPrice;
            const transaction = Object.assign({ from: from, to: this.address, data: data, gasPrice: gasPrice, gas: gas }, attachedEth ? { value: attachedEth } : {});
            const signedTransaction = await this.accountManager.signTransaction(transaction);
            return await this.connector.ethjsQuery.sendRawTransaction(signedTransaction);
        }
    }

    ${contractInterfaces.join("\n")}
    export function ContractFactory(connector: Connector, accountManager: AccountManager, address: string, defaultGasPrice: BN): Controlled {
        return new Controlled(connector, accountManager, address, defaultGasPrice);
    }
    `;
    }

    private contractInterfaceTemplate(contractName: String, contractAbi: Abi) {
        const contractMethods: Array<String> = [];

        // Typescript doesn't allow the same name for a function. We only have one existing case for function overloading in a class and it has the same signature, so this is ok at the moment.
        const seen: Set<string> = new Set();

        const contractFunctions: Array<AbiFunction> = contractAbi
            .filter(v => v.type == "function")
            .map(v => <AbiFunction>v);

        for (let abiFunction of contractFunctions) {
            if (seen.has(abiFunction.name)) continue;
            if (!abiFunction.constant) {
                contractMethods.push(this.remoteMethodTemplate(abiFunction));
            }
            contractMethods.push(this.localMethodTemplate(abiFunction));
            seen.add(abiFunction.name);
        }

        const extendsControlled: boolean = seen.has("getController") && contractName != "Controlled";
        if (extendsControlled) {
            if (!seen.has("extractTokens") && contractName != "Delegator" && contractName != "Map") {
                throw new Error("Controlled contracts must inherit the Extractable class. " + contractName + " does not.");
            }
        }

        return `export class ${contractName} extends ${extendsControlled ? "Controlled" : "Contract"} {
    public constructor(connector: Connector, accountManager: AccountManager, address: string, defaultGasPrice: BN) {
        super(connector, accountManager, address, defaultGasPrice);
    }

${contractMethods.join("\n\n")}
}
`
    }

    private remoteMethodTemplate(abiFunction: AbiFunction) {
        const argNames: String = this.getArgNamesString(abiFunction);
        const params: String = this.getParamsString(abiFunction);
        const options: String = `{ sender?: string, gasPrice?: BN${abiFunction.payable ? ", attachedEth?: BN" : ""} }`;
        return `    public ${abiFunction.name} = async(${params} options?: ${options}): Promise<string> => {
        options = options || {};
        const abi: AbiFunction = ${JSON.stringify(abiFunction)};
        return await this.remoteCall(abi, [${argNames}], options.sender, options.gasPrice${abiFunction.payable ? ", options.attachedEth" : ""});
    }`;
    }

    private localMethodTemplate(abiFunction: AbiFunction) {
        const argNames: String = this.getArgNamesString(abiFunction);
        const params: String = this.getParamsString(abiFunction);
        const options: String = `{ sender?: string${abiFunction.payable ? ", attachedEth?: BN" : ""} }`;
        const returnType: String = (abiFunction.outputs[0] !== undefined) ? this.getTsTypeFromPrimitive(abiFunction.outputs[0].type) : "void";
        const returnPromiseType: String = (abiFunction.outputs.length === 0 || abiFunction.outputs.length === 1) ? returnType : "Array<string>";
        const returnValue: String = abiFunction.outputs.length == 1 ? `<${returnType}>result[0]` : "<Array<string>>result";
        return `    public ${abiFunction.name}_ = async(${params} options?: ${options}): Promise<${returnPromiseType}> => {
        options = options || {};
        const abi: AbiFunction = ${JSON.stringify(abiFunction)};
        ${abiFunction.outputs.length !== 0 ? 'const result = ' : ''}await this.localCall(abi, [${argNames}], options.sender${abiFunction.payable ? ", options.attachedEth" : ""});
        ${abiFunction.outputs.length !== 0 ? `return ${returnValue};` : ''}
    }`;
    }

    private getTsTypeFromPrimitive(abiType: Primitive) {
        switch(abiType) {
            case 'uint8':
            case 'uint64':
            case 'uint256':
            case 'int256': {
                return 'BN';
            }
            case 'string':
            case 'address':
            case 'bytes20':
            case 'bytes32':
            case 'bytes': {
                return 'string';
            }
            case 'bool': {
                return 'boolean';
            }
            case 'address[]': {
                return 'Array<string>'
            }
            case 'uint256[]': {
                return 'Array<BN>';
            }
            case 'bytes32[]': {
                return 'Array<string>';
            }
            default: {
                throw "Unrecognized Value: " + abiType;
            }
        }
    }

    private getArgNamesString(abiFunction: AbiFunction) {
        return abiFunction.inputs.map((v, i) => v.name.substr(1) || `arg${i}`).join(", ");
    }

    private getParamsString(abiFunction: AbiFunction) {
        if (abiFunction.inputs.length == 0) return "";
        return abiFunction.inputs.map((v, i) => (v.name.substr(1) || `arg${i}`) + ": " + this.getTsTypeFromPrimitive(v.type)).join(", ") + ",";
    }
}
