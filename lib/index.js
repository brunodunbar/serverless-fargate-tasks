'use strict';

class ServerlessFargateTasks {
    constructor(serverless, options) {
        this.serverless = serverless;
        this.service = serverless.service;
        this.provider = serverless.getProvider('aws');
        this.options = options || {};
        this.debug = this.options.debug || process.env.SLS_DEBUG;
        this.colors = get(this.serverless, 'processedInput.options.color', true);
        this.hooks = {
            'package:compileFunctions': this.compileTasks.bind(this)
        };
    }

    compileTasks() {
        const template = this.serverless.service.provider.compiledCloudFormationTemplate;
        const colors = this.colors;
        const options = this.serverless.service.custom.fargate;
        const debug = this.debug;
        const consoleLog = this.serverless.cli.consoleLog;

        if (debug) consoleLog(yellow('Fargate Tasks Plugin'));

        // add the cluster
        template['Resources']['FargateTasksCluster'] = {
            "Type": "AWS::ECS::Cluster",
            "Properties": {
                "ClusterName": options.clusterName || `${this.service.service}-${this.service.provider.stage}`
            }
        };

        // Create a loggroup for the logs
        template['Resources']['FargateTasksLogGroup'] = {
            "Type": "AWS::Logs::LogGroup",
            "LogGroupName": options.logGroupName || `${this.service.service}-${this.service.provider.stage}`
        };

        // for each defined task, we create a service and a task, and point it to
        // the created cluster
        Object.keys(options.tasks).forEach(identifier => {
            var name = this.provider.naming.normalizeNameToAlphaNumericOnly(identifier);
            consoleLog(identifier);
            consoleLog(name);
            consoleLog(options.tasks[identifier]);

            // get all override values, if they exists
            var override = options.tasks[identifier]['override'] || {};
            var container_override = override['container'] || {};
            var task_override = override['task'] || {};
            var service_override = override['service'] || {};
            var network_override = override['network'] || {};

            consoleLog(override);
            if (!override.hasOwnProperty('role')) {
                // check if the default role can be assumed by ecs, if not, make it so
                if (template.Resources.IamRoleLambdaExecution.Properties
                    .AssumeRolePolicyDocument.Statement[0].Principal.Service.indexOf('ecs-tasks.amazonaws.com') === -1) {
                    template.Resources.IamRoleLambdaExecution.Properties.AssumeRolePolicyDocument.Statement[0]
                        .Principal.Service.push('ecs-tasks.amazonaws.com')

                    // check if there already is a ManagedPolicyArns array, if not, create it
                    if (!template.Resources.IamRoleLambdaExecution.Properties.hasOwnProperty('ManagedPolicyArns')) {
                        template.Resources.IamRoleLambdaExecution.Properties['ManagedPolicyArns'] = [];
                    }
                    template.Resources.IamRoleLambdaExecution.Properties['ManagedPolicyArns']
                        .push('arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy')
                }
            }

            // create a key/value list for the task environment
            let environment = [];
            if (options.tasks[identifier].hasOwnProperty('environment')) {

                // when a global environment is set, we need to extend it
                var target_environment = options['environment'] || {}
                target_environment = Object.assign(target_environment, options.tasks[identifier].environment)

                Object.keys(target_environment).forEach(function (key, index) {
                    let value = target_environment[key];

                    // any non-string value needs to be send through as json
                    if (typeof value == 'object') {
                        environment.push({"Name": key, "Value": JSON.stringify(value)})
                    } else {
                        environment.push({"Name": key, "Value": value})
                    }
                })
            }

            // create the container definition
            var definitions = Object.assign({
                'Name': identifier,
                'Image': options.tasks[identifier]['image'],
                'Environment': environment,
                'LogConfiguration': {
                    'LogDriver': 'awslogs',
                    'Options': {
                        'awslogs-region': {"Fn::Sub": "${AWS::Region}"},
                        'awslogs-group': {"Fn::Sub": "${FargateTasksLogGroup}"},
                        'awslogs-stream-prefix': 'fargate'
                    },
                },
            }, container_override);

            // create the task definition
            template['Resources'][name + 'Task'] = {
                'Type': 'AWS::ECS::TaskDefinition',
                'Properties': Object.assign({
                    'ContainerDefinitions': [definitions],
                    'Family': identifier,
                    'NetworkMode': 'awsvpc',
                    'ExecutionRoleArn': options['role'] || {"Fn::Sub": 'arn:aws:iam::${AWS::AccountId}:role/ecsTaskExecutionRole'},
                    'TaskRoleArn': override['role'] || {"Fn::Sub": '${IamRoleLambdaExecution}'},
                    'RequiresCompatibilities': ['FARGATE'],
                    'Memory': options.tasks[identifier]['memory'] || "0.5GB",
                    'Cpu': options.tasks[identifier]['cpu'] || 256,
                }, task_override)
            };

            // create the service definition
            template['Resources'][name + 'Service'] = {
                'Type': 'AWS::ECS::Service',
                'Properties': Object.assign({
                    'Cluster': {"Fn::Sub": '${FargateTasksCluster}'},
                    'LaunchType': 'FARGATE',
                    'ServiceName': identifier,
                    'DesiredCount': options.tasks[identifier]['desired'] !== undefined ? options.tasks[identifier]['desired'] : 1,
                    'TaskDefinition': {"Fn::Sub": '${' + name + 'Task}'},
                    'NetworkConfiguration': {
                        'AwsvpcConfiguration': Object.assign({
                            'AssignPublicIp': options.vpc['public-ip'] || "DISABLED",
                            'SecurityGroups': options.vpc['security-groups'] || [],
                            'Subnets': options.vpc['subnets'] || [],
                        }, network_override),
                    }
                }, service_override)
            }
        });

        function yellow(str) {
            if (colors) return '\u001B[33m' + str + '\u001B[39m';
            return str;
        }

    }
}

function get(obj, path, def) {
    return path.split('.').filter(Boolean).every(step => !(step && (obj = obj[step]) === undefined)) ? obj : def;
}

module.exports = ServerlessFargateTasks;
