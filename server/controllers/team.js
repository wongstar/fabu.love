'use strict';

import {
    request,
    summary,
    tags,
    body,
    query,
    path,
    description
} from '../swagger';
import {User, userSchema} from "../model/user";
import Message from "../model/message";
import Team from "../model/team";
import {responseWrapper} from "../helper/util";
import Fawn from "fawn";
import mongoose from "mongoose";
import validator from "../helper/validator";

const tag = tags(['团队']);

var teamCreateSchema = {
    name: {
        type: 'string',
        required: true
    },
    icon: {
        type: 'string',
        required: false
    }
}

module.exports = class TeamRouter {
    @request('post', '/api/team/create')
    @summary('创建一个团队')
    @tag
    @body(teamCreateSchema)
    static async createTeam(ctx, next) {
        var user = ctx.state.user.data;
        var {body} = ctx.request;
        var team = await Team.findOne({name: body.name})
        if (team) {
            throw new Error("团队名称已被使用")
        }
        team = new Team(body);
        team.creatorId = user._id;
        team.members = [
            {
                _id: user._id,
                username: user.username,
                email:user.email,
                role: "owner"
            }
        ]

        var task = Fawn.Task();
        var result = await task
            .save(team)
            .update(User, {
                _id: user._id
            }, {
                $push: {
                    teams: {
                        _id: team._id,
                        name: team.name,
                        icon: team.icon,
                        role: "owner"
                    }
                }
            })
            .run({useMongoose: true});

        ctx.body = responseWrapper(team)
    }

    @request('post', '/api/team/dissolve/{id}')
    @summary('解散一个团队')
    @tag
    @path({
        id: {
            type: 'string',
            required: true
        }
    })
    static async dissolveTeam(ctx, next) {
        const {id} = ctx.validatedParams;
        var user = ctx.state.user.data;
        var team = await Team.findOne({'_id': id, 'members.username': user.username, 'members.role': 'owner'});
        if (!team) {
            throw new Error("该团队不存在或者您没有权限解散该团队")
        }
        if (team.members.length > 0) {
            throw new Error("请先删除所有成员再解散团队")
        }
        await Team.deleteOne(team)
        ctx.body = responseWrapper(true, "团队已解散")
    }

    @request('post', '/api/team/{teamId}/invite')
    @summary('邀请某成员加入团队')
    @tag
    @body({
        emailList: {
            type: 'array',
            items: {
                type: 'string'
            },
            description: "邮箱列表",
            required: true
        },
        role:{type:'string',required:true,description: "成员角色manager/guest"}
    })
    @path({
        teamId: {
            type: 'string',
            required: true
        }
    })
    static async addMember(ctx, next) {
        var {teamId, emailList} = ctx.validatedParams;
        var user = ctx.state.user.data;
        var body = ctx.request.body
        if (!(body.role === 'manager' || body.role === 'role')) {
            throw new Error("请传入正确的用户角色")
        }

        var team = await Team.findOne({_id:teamId,members:{
            $elemMatch:{
                 id:userId,
                 $or: [
                    { role: 'owner' },
                    { role: 'manager' }
                ]
            }
        },},"_id")

        if (!team) {
            throw new Error("团队不存在,或者您没有权限邀请用户加入")
        }

        var userList = await User.find({
            email:{ $in : emailList }
        },"username email")

        var teamList = []
        for (u in userList){
            teamList.push({
                _id:u.id,
                username:u.username,
                email:u.email,
                role:body.role
            })
        }

        var task = Fawn.Task();
        var result = await task
            .update(Team,{id:teamId},{
                $addToSet:{members:{ $each: teamList }}
            })
            .update(User, {email:{ $in : emailList }},{
                $push: {
                    teams: {
                        _id: teamId,
                        name: team.name,
                        icon: team.icon,
                        role: body.role
                    }
                }
            })
            .run({useMongoose: true});


        for (u in userList){
            var message = new Message();
            message.category = "INVITE";
            message.content = user.name + "邀请您加入" + team.name + "团队."
            message.sender = user._id;
            message.receiver = u.id;
            // message.data = jwt.sign({
            //     data: {
            //         teamId: team._id,
            //         invited: userIdentifier
            //     },
            //     exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7)
            // }, 'jwt-secret')
            message.save();
        }
        //TODO 发送邮件邀请
        ctx = responseWrapper(true, "已发送邮件邀请该用户")
    }

    @request('delete', '/api/team/{id}/member/{userId}')
    @summary('移除某个成员,或者自己离开团队')
    @tag
    @path({
        id: {
            type: 'string',
            required: true
        },
        userId: {
            type: 'string',
            required: true
        }
    })
    static async removeMember(ctx, next) {
        var {id, userId} = ctx.validatedParams;
        var user = ctx.state.user.data;
        //如果传入的id和当前登录用户的id相等 表示是自己离开团队
        var queryCondition;
        if (userId === user._id) {
            queryCondition = {$elemMatch: 
                { username: user.username }
            }
        }else{
            queryCondition = {
                $elemMatch: [
                    {
                        username: user.username,
                        role: "owner"
                    }, {
                        username: user.username,
                        role: "manager"
                    }
                ]
            }
        }
        var team = await Team.find({
            _id: id,
            members: queryCondition
        })
        if (!team) {
            throw new Error("团队不存在或该用户没有权限删除用户")
        }
        var task = Fawn.Task();
        var result = await task
            .update(team,{$pull:{members:{_id:id}}})
            .update(User, {
                _id: user._id
            }, {
                $pull: {
                    teams: {
                        _id: team._id,
                    }
                }
            }).run({useMongoose: true});
        ctx.body = responseWrapper(true,"请求成功")
    }
    

    @request('get', '/api/team/{teamId}/members')
    @summary('获取团队成员列表')
    @tag
    @path({
        teamId: {
            type: 'string',
            required: true
        }
    })
    static async getMembers(ctx, next) {
        var { teamId } = ctx.validatedParams;
        var user = ctx.state.user.data;
        //如果传入的id和当前登录用户的id相等 表示是自己离开团队
        var team = await Team.find({
            _id: teamId,
        })
        if (!team) {
            throw new Error("团队不存在")
        }
        ctx.body = responseWrapper(team)
    }

    
}