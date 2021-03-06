/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { JsonType } from '#common/code-model/schema';
import { items, length, values } from '#common/linq';
import { escapeString, pascalCase } from '#common/text-manipulation';
import { Access, Modifier } from '#csharp/code-dom/access-modifier';
import { Attribute } from '#csharp/code-dom/attribute';
import { Class } from '#csharp/code-dom/class';
import { LiteralExpression, StringExpression, valueOf } from '#csharp/code-dom/expression';
import { InitializedField } from '#csharp/code-dom/field';
import { Method } from '#csharp/code-dom/method';
import { Namespace } from '#csharp/code-dom/namespace';
import { ImplementedProperty } from '#csharp/code-dom/property';
import { Statements } from '#csharp/code-dom/statements/statement';
import { MemberVariable, Variable } from '#csharp/code-dom/variable';
import { Schema } from '#csharp/lowlevel-generator/code-model';

import { CmdletAttribute, OutputTypeAttribute, ParameterAttribute, PSCmdlet, SwitchParameter } from '#powershell/powershell-declarations';
import { State } from './state';
import { Binary } from '#csharp/schema/binary';
import { System } from '#csharp/code-dom/dotnet';

export interface WithState extends Class {
  state: State;
}

export class ModelCmdlet extends Class {
  public state: State;
  // protected processRecord: Method;

  constructor(namespace: Namespace, schema: Schema, state: State, objectInitializer?: Partial<ModelCmdlet>) {
    const name = `New${state.project.nounPrefix}${schema.details.csharp.name}Object`;

    super(namespace, name, PSCmdlet);
    this.state = state;
    this.description = `Cmdlet to create an in-memory instance of the <see cref="${schema.details.csharp.name}" /> object.`
    this.apply(objectInitializer);
    addClassAttributes(this, schema, name);

    const td = this.state.project.schemaDefinitionResolver.resolveTypeDeclaration(schema, true, this.state);
    const prop = this.add(new InitializedField(`_${schema.details.csharp.name.uncapitalize()}`, td, `new ${schema.details.csharp.namespace}.${schema.details.csharp.name}()`, { access: Access.Private, description: `Backing field for <see cref="${schema.details.csharp.name}" />` }));

    const processRecord = this.add(new Method('ProcessRecord', undefined, { access: Access.Protected, override: Modifier.Override, description: `Performs execution of the command.` })).add(`WriteObject(${prop});`);

    // adds the parameters to the cmdlet and adds to the method to set the value from the parameter.
    addPowershellParameters(this, schema, prop);
  }

}

function addClassAttributes($class: WithState, schema: Schema, name: string) {
  const td = $class.state.project.schemaDefinitionResolver.resolveTypeDeclaration(schema, true, $class.state);
  $class.add(new Attribute(CmdletAttribute, { parameters: [`System.Management.Automation.VerbsCommon.New`, new StringExpression(`${$class.state.project.nounPrefix}${schema.details.csharp.name || ''}Object`)] }));
  $class.add(new Attribute(OutputTypeAttribute, { parameters: [`typeof(${td.declaration})`] }));
}

export function addPowershellParameters($class: WithState, schema: Schema, prop: Variable, ensureMemberIsCreated: Statements | undefined = undefined, expandName = false) {

  // next:
  // -- inline parameters from member property models.
  // polymorphic models?

  if (schema.details.csharp.isPolymorphic) {
    console.error(`\n\nPOLYMORPHIC TYPE! ${schema.details.csharp.name}`);
  }

  for (const a of values(schema.allOf)) {
    addPowershellParameters($class, a, prop);
  }

  // add a parameter for each property
  for (const { key: name, value: property } of items(schema.properties)) {

    const td = $class.state.project.schemaDefinitionResolver.resolveTypeDeclaration(property.schema, true, $class.state);



    if (property.schema.type === JsonType.Object) {
      // properties property get inlining without hassle
      const member = new MemberVariable(prop, property.details.csharp.name);

      if (name === 'properties') {
        // inline these properties instead.
        const ensure = new Statements(ensureMemberIsCreated);
        ensure.add(`${valueOf(member)} = ${valueOf(member)} ?? new ${property.schema.details.csharp.fullname}();`);

        addPowershellParameters($class, property.schema, member, ensure);
        continue;
      }

      if (!property.schema.additionalProperties) {
        // first check if there are multiple instances of the same nested type. (ie, BodyColor and HoodColor would both be color.)
        // if so, we really can't inline properties of identical members.
        /*
                const subProps = values(property.schema.properties).linq.toArray();
                const uniq = values(subProps).linq.distinct(subProperty => subProperty.schema).linq.toArray();
                if( uniq.length == subProps.length ) {
                  // all types are unique.

                }
          */
        if (length(property.schema.properties) <= $class.state.project.maxInlinedParameters) {
          // inline these properties instead.
          const ensure = new Statements(ensureMemberIsCreated);
          ensure.add(`${valueOf(member)} = ${valueOf(member)} ?? new ${property.schema.details.csharp.fullname}();`);

          addPowershellParameters($class, property.schema, member, ensure, true);
          continue;
        }
      }
    }

    // other properties
    if (property.schema.type === JsonType.Object) {
      // console.error(`\n\nLARGE OBJECT NOT INLINED ${property.details.csharp.name}`);
    }

    if (!property.schema.readOnly) {
      // add a cmdlet parameter

      let cmdletParameter: ImplementedProperty;

      const pname = expandName ? pascalCase([schema.details.csharp.name, property.details.csharp.name]) : property.details.csharp.name;

      if (property.schema.type === JsonType.Boolean) {
        // use a switch instead
        cmdletParameter = $class.add(new ImplementedProperty(pname, SwitchParameter, {

          /* getterStatements: new Statements(function* () {
             if (ensureMemberIsCreated) {
               yield ensureMemberIsCreated;

             }
             yield Return(`new System.Management.Automation.SwitchParameter(true == ${prop}.${property.details.csharp.name});`);
           }), */
          setterStatements: new Statements(function* () {
            if (ensureMemberIsCreated) {
              yield ensureMemberIsCreated;
            }
            yield `${prop}.${property.details.csharp.name} = value.ToBool();`;
          }),
        }));
        // statements.add(indent(`${property.details.csharp.name} = this.MyInvocation.BoundParameters.ContainsKey("${property.details.csharp.name}") ? this.${property.details.csharp.name}.ToBool() : default(${td.declaration}),`));
      } else {

        let propname = pname;
        let n = 1;
        while ($class.properties.find(p => p.name === propname)) {
          // property exists with that name
          // let's hack this a smidgen
          propname = `${pname}${n++}`;
        }

        if (td instanceof Binary) {
          // if the parameter is a binary; this is going to try and make a stream parameter
          // which in powershell, kinda sucks.

          // so instead, let's substitute a parameter that takes a filename and sets the stream
          cmdletParameter = $class.add(new ImplementedProperty(propname, System.String, {
            setterStatements: new Statements(function* () {
              if (ensureMemberIsCreated) {
                yield ensureMemberIsCreated;
              }
              yield `var matches = this.SessionState.Path.GetResolvedProviderPathFromPSPath(value,out var provider);`
              yield `switch (matches.Count) {
case 0:
  throw new System.IO.FileNotFoundException($"Unable to locate file '{value}'", value);
case 1:
  ${prop}.${property.details.csharp.name} =  System.IO.File.OpenRead(matches[0]);
  break;
default:
  throw new System.Exception($"'{value}' matches more than one file: {System.Linq.Enumerable.Aggregate(matches, (c,e) => $"{ c }, { e }") }");
}`;
            }),
          }));
        } else {

          cmdletParameter = $class.add(new ImplementedProperty(propname, td, {
            setterStatements: new Statements(function* () {
              if (ensureMemberIsCreated) {
                yield ensureMemberIsCreated;
              }
              yield `${prop}.${property.details.csharp.name} = value;`;
            }),
          }));
        }
        // statements.add(indent(`${property.details.csharp.name} = this.MyInvocation.BoundParameters.ContainsKey("${property.details.csharp.name}") ? this.${property.details.csharp.name} : default(${td.declaration}),`));
      }

      const desc = (property.details.csharp.description || 'HELP MESSAGE MISSING').replace(/[\r?\n]/gm, '');
      cmdletParameter.add(new Attribute(ParameterAttribute, { parameters: [new LiteralExpression(`Mandatory = ${property.details.default.required ? 'true' : 'false'}`), new LiteralExpression(`HelpMessage = "${escapeString(desc)}"`)] }));
      cmdletParameter.description = desc;
    }
  }

  // if
}

function getUniquePropertyNames(schema: Schema) {

}
