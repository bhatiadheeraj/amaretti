#!/bin/bash

#This script will be copied to each resource every time resource checker test resource status and used to test the resource

#check for common binaries
which git >/dev/null
if [ ! $? -eq 0 ]; then
    echo "git not installed on PATH"
    exit 1
fi

#I am not sure about this one yet..
#which git-lfs >/dev/null
#if [ ! $? -eq 0 ]; then
#    echo "git-lfs not installed on PATH"
#    exit 1
#fi

which singularity >/dev/null
if [ ! $? -eq 0 ]; then
    echo "singularity not installed on PATH"
    #TODO _ should I check the version / configuration?
    exit 1
fi

which jq >/dev/null
if [ ! $? -eq 0 ]; then
    echo "jq not installed on PATH"
    exit 1
fi

which unzip >/dev/null
if [ ! $? -eq 0 ]; then
    echo "unzip not installed on PATH"
    exit 1
fi

#check for default abcd hook
which start >/dev/null
if [ ! $? -eq 0 ]; then
    echo "abcd-hook 'start' not installed on PATH"
    exit 1
fi

which stop >/dev/null
if [ ! $? -eq 0 ]; then
    echo "abcd-hook 'stop' not installed on PATH"
    exit 1
fi

which status >/dev/null
if [ ! $? -eq 0 ]; then
    echo "abcd-hook 'status' not installed on PATH"
    exit 1
fi

#make sure batch scheduler is alive (and responsive)
if hash squeue 2>/dev/null; then
    timeout 5 sinfo >/dev/null
    if [ ! $? -eq 0 ]; then
        echo "squeue/sinfo seem to be not working.. maybe something wrong with the scheduler?"
        exit 1
    fi
elif hash qstat 2>/dev/null; then
    timeout 5 qstat -q >/dev/null
    if [ ! $? -eq 0 ]; then
        echo "qstat seems to be not working.. maybe something wrong with the scheduler?"
        exit 1
    fi
elif hash condor_q 2>/dev/null; then
    timeout 10 condor_q $USER >/dev/null
    if [ ! $? -eq 0 ]; then
        echo "condor_q seems to be not working.. maybe something wrong with the scheduler?"
        exit 1
    fi
fi

#check for access right
mkdir -p _resource_check && rmdir _resource_check
if [ ! $? -eq 0 ]; then
    echo "couldn't write to workdir: `pwd`"
    exit 1
fi

#check workdir free size
available=$(df . | awk 'NR==2{print $4}')
if [ $available -lt 10737418 ]; then
    echo "less than 10 GB left on workdir"
    df .
fi
