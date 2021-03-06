/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Access, Modifier } from '#csharp/code-dom/access-modifier';
import { Class } from '#csharp/code-dom/class';
import { Constructor } from '#csharp/code-dom/constructor';
import { ClassType, dotnet, System } from '#csharp/code-dom/dotnet';
import { LiteralExpression, StringExpression } from '#csharp/code-dom/expression';
import { Field, InitializedField } from '#csharp/code-dom/field';
import { Alias } from '#csharp/code-dom/import';
import { LambdaMethod, Method, PartialMethod } from '#csharp/code-dom/method';

import { Namespace } from '#csharp/code-dom/namespace';
import { Parameter } from '#csharp/code-dom/parameter';
import { ParameterModifier } from '#csharp/code-dom/parameter-modifier';
import { LambdaProperty, LazyProperty, Property } from '#csharp/code-dom/property';
import { Return } from '#csharp/code-dom/statements/return';
import { Using } from '#csharp/code-dom/statements/using';
import { LocalVariable } from '#csharp/code-dom/variable';
import { ClientRuntime } from '#csharp/lowlevel-generator/clientruntime';
import { PSCredential } from '#powershell/powershell-declarations';
import { State } from '#powershell/state';

export class ModuleClass extends Class {

  constructor(namespace: Namespace, private state: State, objectInitializer?: Partial<ModuleClass>) {
    super(namespace, 'Module');
    this.apply(objectInitializer);
    this.partial = true;
    this.description = `A class that contains the module-common code and data.`;

    // static instance property
    this.add(new LazyProperty('Instance', this, new LiteralExpression(`new ${this.declaration}()`), {
      instanceAccess: this.declaration,
      static: Modifier.Static,
      description: `the singleton of this module class`
    }));

    const isAzure = this.state.project.azure;

    // get the name of the client API class
    const TaskOfHttpResponseMessage = System.Threading.Tasks.Task(System.Net.Http.HttpResponseMessage);
    const BoundParameterDictionary = System.Collections.Generic.Dictionary(dotnet.String, dotnet.Object);

    const clientAPI = new ClassType(this.state.model.details.csharp.namespace, this.state.model.details.csharp.name);

    const clientProperty = this.add(new Property('ClientAPI', clientAPI, { description: `The instance of the Client API` }));

    // lets the common code call the signal again (recursive! careful!)
    const signalDelegateI = System.Func(
      dotnet.String,
      System.Threading.CancellationToken,
      System.Func(System.EventArgs),
      /* returns */ System.Threading.Tasks.Task());

    const signalDelegate = System.Func(
      dotnet.String,
      System.Threading.CancellationToken,
      System.Func(System.EventArgs),
      signalDelegateI,
      /* returns */ System.Threading.Tasks.Task());

    const IEventListenerExpanded = [
      System.Threading.CancellationToken, /* token */
      System.Action(),                    /* Cancel() */
      signalDelegateI,
    ];

    const nextStep = System.Func(
      System.Net.Http.HttpRequestMessage,
      ...IEventListenerExpanded,
      /* returns */ TaskOfHttpResponseMessage);

    const signalDelegateIAlias = namespace.add(new Alias('SignalDelegateI', signalDelegateI));
    const signalDelegateAlias = namespace.add(new Alias('SignalDelegate', signalDelegate));

    const getParameterDelegate = namespace.add(new Alias('GetParameterDelegate', System.Func(
      dotnet.String,
      dotnet.String,
      BoundParameterDictionary,
      dotnet.String,
      /* returns */ dotnet.Object)));

    const sendAsyncStep = namespace.add(new Alias('SendAsyncStepDelegate',
      System.Func(
        System.Net.Http.HttpRequestMessage,
        ...IEventListenerExpanded,
        nextStep,                                  /* Next( ...) */
        /* returns */ TaskOfHttpResponseMessage)));

    const boundParams = new Parameter('boundParameters', System.Collections.Generic.Dictionary(dotnet.String, dotnet.Object), { description: `The bound parameters from the cmdlet call.` });
    const pipelineField = this.add(new Field('_pipeline', ClientRuntime.HttpPipeline, { access: Access.Private, description: `the ISendAsync pipeline instance` }));
    const pipelineWithProxyField = this.add(new Field('_pipelineWithProxy', ClientRuntime.HttpPipeline, { access: Access.Private, description: `the ISendAsync pipeline instance (when proxy is enabled)` }));
    const webProxyField = this.add(new InitializedField('_webProxy', System.Net.WebProxy, System.Net.WebProxy.new()));

    const handlerField = new InitializedField('_handler', System.Net.Http.HttpClientHandler, System.Net.Http.HttpClientHandler.new());
    this.add(handlerField);

    const createPipeline = this.add(new Method('CreatePipeline', ClientRuntime.HttpPipeline, {
      parameters: [boundParams],
      description: `Creates an instance of the HttpPipeline for each call.`,
      returnsDescription: `An instance of ${ClientRuntime.HttpPipeline} for the remote call.`

    }));

    const init = this.add(new Method('Init', dotnet.Void, { description: `Initialization steps performed after the module is loaded.` }));

    if (isAzure) {
      const pipelineChangeDelegate = namespace.add(new Alias('PipelineChangeDelegate', System.Action(sendAsyncStep.fullDefinition)));
      const nextDelegate = namespace.add(new Alias('NextDelegate', nextStep));

      const moduleLoadPipelineAction = namespace.add(new Alias('ModuleLoadPipelineDelegate', System.Action(dotnet.String, dotnet.String, pipelineChangeDelegate.fullDefinition, pipelineChangeDelegate.fullDefinition)));
      const newRequestPipelineAction = namespace.add(new Alias('NewRequestPipelineDelegate', System.Action(System.Collections.Generic.Dictionary(dotnet.String, dotnet.Object), pipelineChangeDelegate.fullDefinition, pipelineChangeDelegate.fullDefinition)));

      const OnModuleLoad = this.add(new Property('OnModuleLoad', moduleLoadPipelineAction, { description: `The delegate to call when this module is loaded (supporting a commmon module).` }));
      const OnNewRequest = this.add(new Property('OnNewRequest', newRequestPipelineAction, { description: `The delegate to call before each new request (supporting a commmon module).` }));

      const moduleIdentity = this.add(new LambdaProperty('Name', dotnet.String, new StringExpression(state.project.moduleName), { description: `The Name of this module ` }));
      const moduleResourceId = this.add(new LambdaProperty('ResourceId', dotnet.String, new StringExpression(state.project.moduleName), { description: `The ResourceID for this module (azure arm).` }));

      init.add(function* () {
        yield `${OnModuleLoad.value}?.Invoke( ${moduleResourceId.value}, ${moduleIdentity.value} ,(step)=> { ${pipelineField.value}.Prepend(step); } , (step)=> { ${pipelineField.value}.Append(step); } );`;
        yield `${OnModuleLoad.value}?.Invoke( ${moduleResourceId.value}, ${moduleIdentity.value} ,(step)=> { ${pipelineWithProxyField.value}.Prepend(step); } , (step)=> { ${pipelineWithProxyField.value}.Append(step); } );`;
        yield `CustomInit();`;
      });

      const GetParameterValue = this.add(new Property('GetParameterValue', getParameterDelegate, { description: `The delegate to call to get parameter data from a common module.` }));
      const pBoundParameters = new Parameter('boundParameters', BoundParameterDictionary, { description: `The bound parameters from the cmdlet call.` });
      const pKey = new Parameter('parameterName', dotnet.String, { description: `The name of the parameter to get the value for.` });
      const GetParameter = this.add(new LambdaMethod('GetParameter', dotnet.Object, new LiteralExpression(`${GetParameterValue.value}?.Invoke( ${moduleResourceId.value}, ${moduleIdentity.value}, ${pBoundParameters.value}, ${pKey.value} )`), {
        parameters: [pBoundParameters, pKey],
        description: `Gets parameters from a common module.`,
        returnsDescription: `The parameter value from the common module. (Note: this should be type converted on the way back)`
      }));

      const EventListener = this.add(new Property('EventListener', signalDelegateAlias, { description: `A delegate that gets called for each signalled event` }));

      const pId = new Parameter('id', dotnet.String, { description: `The ID of the event ` });
      const pToken = new Parameter('token', System.Threading.CancellationToken, { description: `The cancellation token for the event ` });
      const pGetEvent = new Parameter('getEventData', System.Func(System.EventArgs), { description: `A delegate to get the detailed event data` });
      const pSignal = new Parameter('signal', signalDelegateIAlias, { description: `The callback for the event dispatcher ` });
      const signalImpl = this.add(new Method('Signal', System.Threading.Tasks.Task(), {
        parameters: [pId, pToken, pGetEvent, pSignal], async: Modifier.Async,
        description: `Called to dispatch events to the common module listener`,
        returnsDescription: `A <see cref="${System.Threading.Tasks.Task()}" /> that will be complete when handling of the event is completed.`
      }));
      signalImpl.push(Using(`NoSynchronizationContext`, ``));
      signalImpl.add(function* () {
        yield `await ${EventListener.value}?.Invoke(${pId.value},${pToken.value},${pGetEvent.value}, ${pSignal.value});`;
      });

      createPipeline.add(function* () {
        const pip = new LocalVariable('pipeline', ClientRuntime.HttpPipeline, { initializer: 'null' });
        yield pip.declarationStatement;
        yield `BeforeCreatePipeline(boundParameters, ref ${pip});`;
        yield pip.assign(`(${pip} ?? (${handlerField}.UseProxy ? ${pipelineWithProxyField} : ${pipelineField})).Clone()`);
        yield `AfterCreatePipeline(boundParameters, ref ${pip});`;
        yield `    ${OnNewRequest.value}?.Invoke( ${boundParams.use}, (step)=> { ${pip}.Prepend(step); } , (step)=> { ${pip}.Append(step); } );`;
        yield Return(pip);
      });

    } else {
      // non-azure init method
      init.add(function* () {
        yield `// called at module init time...`;
        yield `CustomInit();`;
      });

      // non-azure createPipeline method
      createPipeline.add(function* () {
        const pip = new LocalVariable('pipeline', ClientRuntime.HttpPipeline, { initializer: 'null' });
        yield pip.declarationStatement;
        yield `BeforeCreatePipeline(boundParameters, ref ${pip});`;
        yield pip.assign(`(${pip} ?? (${handlerField}.UseProxy ? ${pipelineWithProxyField} : ${pipelineField})).Clone()`);
        yield `AfterCreatePipeline(boundParameters, ref ${pip});`;
        yield Return(pip);
      });
    }

    this.add(new Constructor(this, {
      access: Access.Private,
      description: `Creates the module instance.`
    })).add(function* () {
      yield `/// constructor`;
      yield clientProperty.assignPrivate(clientAPI.new());
      yield `${handlerField}.Proxy = ${webProxyField};`;

      yield pipelineField.assignPrivate(ClientRuntime.HttpPipeline.new(ClientRuntime.HttpClientFactory.new(System.Net.Http.HttpClient.new())));
      yield pipelineWithProxyField.assignPrivate(ClientRuntime.HttpPipeline.new(ClientRuntime.HttpClientFactory.new(System.Net.Http.HttpClient.new(handlerField))));
    });

    this.add(new PartialMethod('BeforeCreatePipeline', dotnet.Void, {
      parameters: [new Parameter('boundParams', BoundParameterDictionary), new Parameter('pipeline', ClientRuntime.HttpPipeline, { modifier: ParameterModifier.Ref })]
    }));
    this.add(new PartialMethod('AfterCreatePipeline', dotnet.Void, {
      parameters: [new Parameter('boundParams', BoundParameterDictionary), new Parameter('pipeline', ClientRuntime.HttpPipeline, { modifier: ParameterModifier.Ref })]
    }));
    this.add(new PartialMethod('CustomInit', dotnet.Void));

    const pProxy = new Parameter('proxy', System.Uri);
    const pProxyCredential = new Parameter('proxyCredential', PSCredential);
    const pUseDefaultCredentials = new Parameter('proxyUseDefaultCredentials', dotnet.Bool);

    const spc = new Method('SetProxyConfiguration', dotnet.Void, { parameters: [pProxy, pProxyCredential, pUseDefaultCredentials] });
    spc.add(function* () {
      yield '// set the proxy configuration';
      yield `${webProxyField}.Address = proxy;`;
      yield `${webProxyField}.BypassProxyOnLocal = false;`;
      yield `${webProxyField}.Credentials = proxyCredential ?.GetNetworkCredential();`;
      yield `${webProxyField}.UseDefaultCredentials = proxyUseDefaultCredentials;`;
      yield `${handlerField}.UseProxy = proxy != null;`;
    });
    this.add(spc);
  }
}
